import { z } from 'zod';
import { SimulateRequest, parseLogGroup, type RouteDecision, type SimulateResult } from '@log/shared';
import { converseJson } from '@log/analysis';
import { simulate, DEFAULT_CASHMESSAGE_SAMPLES } from '@log/simulator';

/**
 * How many sets to generate. The explicit "N request/ack/response/sets" phrase
 * in the text wins over the LLM (it confuses id ranges like "001 to 004" with
 * the set count); the LLM value is only a fallback.
 */
export function parseCount(message: string, fromLlm: unknown): number {
  // "N [adjective ]request/ack/…" — allow up to two words (e.g. "3 successful
  // request") between the number and the noun, but never "to" so an id range
  // like "001 to 004" is not read as a count.
  const m = message.match(
    /\b(\d{1,4})\s+(?:(?!to\b)[A-Za-z]+\s+){0,2}(?:request|ack|response|set|message|msg|log|transaction)/i,
  );
  if (m) return Math.max(1, Number(m[1]));
  if (typeof fromLlm === 'number' && fromLlm >= 1) return Math.floor(fromLlm);
  if (typeof fromLlm === 'string' && /^\d+$/.test(fromLlm)) return Number(fromLlm);
  return 1;
}

export function parseStartId(message: string, fromLlm: unknown): string | undefined {
  if (typeof fromLlm === 'string' && fromLlm.trim()) return fromLlm.trim();
  const m = message.match(/message[_\s-]?id\s*(?:=|:|\s|from)\s*([A-Za-z0-9._-]+)/i);
  return m ? m[1] : undefined;
}

/** Which message types to emit, from phrases like "without response". */
export function parseMessageTypes(message: string): ('REQUEST' | 'ACK' | 'RESPONSE')[] {
  const m = message.toLowerCase();
  if (/\b(request)\s*only\b|\bonly\s*(a\s*)?request\b|\bjust\s*(a\s*)?request\b/.test(m)) return ['REQUEST'];
  let types: ('REQUEST' | 'ACK' | 'RESPONSE')[] = ['REQUEST', 'ACK', 'RESPONSE'];
  if (/\b(without|no|missing|w\/o)\s+(a\s+)?response\b/.test(m)) types = types.filter((t) => t !== 'RESPONSE');
  if (/\b(without|no|missing|w\/o)\s+(an?\s+)?ack\b/.test(m)) types = types.filter((t) => t !== 'ACK');
  // "request/ack" (with no mention of response) also implies no response.
  if (/\brequest\s*[/&+]\s*ack\b/.test(m) && !/response/.test(m)) types = ['REQUEST', 'ACK'];
  return types.length ? types : ['REQUEST', 'ACK', 'RESPONSE'];
}

/**
 * Success vs failure ack. Failure words ("failure", "rejected", "nack", …) count
 * only when NOT negated by "no/without/zero/not", so "success and no error"
 * stays success while "ack with failure" is failure.
 */
export function parseAckStatus(message: string): 'success' | 'failure' {
  const m = message.toLowerCase();
  const failure =
    /(?<!\b(?:no|without|zero|not)\s+)(fail(?:ure|ed)?|reject(?:ed)?|\bnack\b|unsuccessful|declined|negative\s+ack)/.test(
      m,
    );
  return failure ? 'failure' : 'success';
}

export const hasCashXml = (s: string): boolean => /<(?:[\w.-]+:)?cashMessage[\s>]/i.test(s);

/** A bare "(1) request:" / "(3) response :" line that just labels a sample block. */
const SAMPLE_LABEL =
  /^\s*\(?\d{1,2}\)?[.:]?\s*(?:request|req|ack|acknowledg(?:e)?ment|response|resp|message|msg)\s*:?\s*$/i;

/**
 * A pasted prompt often mixes XML sample template(s) with the natural-language
 * simulate instructions. Separate them so each is handled correctly: lines
 * containing XML angle-brackets are the sample template; the remaining prose
 * (minus bare "(1) request:" style labels) is the instruction text that gets
 * split into commands. Without this, any pasted XML made the whole blob parse
 * as one command (mixing "(4) success" with "(5) failure").
 */
export function separateSamplesAndInstructions(prompt: string): {
  samples: string;
  instructions: string;
} {
  const xml: string[] = [];
  const instr: string[] = [];
  for (const line of prompt.split(/\r?\n/)) {
    if (/[<>]/.test(line)) xml.push(line);
    else if (SAMPLE_LABEL.test(line)) continue;
    else instr.push(line);
  }
  return { samples: xml.join('\n').trim(), instructions: instr.join('\n').trim() };
}

/**
 * Split a prompt containing several commands into one segment per command, so
 * each is parsed with its own count/types/ackStatus and params never bleed
 * across commands. Boundaries are, in order of preference:
 *   1. line-leading enumeration markers like "(4)", "5)", "3." — the user's
 *      numbered format, reliable even when only one line says "simulate";
 *   2. otherwise repeated "simulate" keywords.
 * A single-command prompt (or pasted XML) returns one segment. Content before
 * the first marker (e.g. "simulate the following:") is dropped as preamble.
 */
export function splitInstructions(prompt: string): string[] {
  if (hasCashXml(prompt)) return [prompt];

  // Enumeration markers, anywhere (not only at line starts, so "(4) … (5) …" on
  // one line still splits): parenthesized "(4)" anywhere, or "4)"/"4." at a line
  // start. Mid-line bare numbers ("001 to 004") are intentionally NOT markers.
  const marks = new Set<number>();
  for (const m of prompt.matchAll(/\(\d{1,2}\)/g)) if (m.index !== undefined) marks.add(m.index);
  for (const m of prompt.matchAll(/(?:^|\n)[ \t]*(\d{1,2}[).])/g)) {
    if (m.index !== undefined) marks.add(m.index + m[0].indexOf(m[1]!));
  }
  const numbered = [...marks].sort((a, b) => a - b);
  const sims = [...prompt.matchAll(/\bsimulate\b/gi)]
    .map((m) => m.index)
    .filter((i): i is number => i !== undefined);

  // Prefer numbered markers; fall back to "simulate" repetitions.
  const starts = numbered.length >= 2 ? numbered : sims.length >= 2 ? sims : [];
  if (starts.length < 2) return [prompt];

  const segs: string[] = [];
  for (let k = 0; k < starts.length; k++) {
    const to = k + 1 < starts.length ? starts[k + 1]! : prompt.length;
    const seg = prompt.slice(starts[k]!, to).trim();
    if (seg) segs.push(seg);
  }
  return segs.length ? segs : [prompt];
}

const SEGMENT_SYSTEM = `You split a user's request into separate cashMessage
simulation commands. One request may describe SEVERAL distinct simulations — e.g.
"3 successful request/ack/response starting 001, and 1 request/ack without
response that fails" is TWO commands. Split on enumerations ("(4)…(5)…"), the word
"simulate", or conjunctions ("and", "then", ";", a new sentence) that separate
distinct simulations. Do NOT split a single command (e.g. "request/ack/response"
is one command, not three).

Return each command as the EXACT verbatim substring of the input, in order,
together covering every command. A single-command request returns one element.

Respond ONLY with JSON: {"commands":["<verbatim substring>", ...]}`;

/**
 * Segment a prompt into one text span per command. Deterministic splitting
 * (numbered markers / repeated "simulate") is tried first because it is exact;
 * only when that yields a single span do we ask the LLM to segment, which
 * handles conjunction-joined prose like "3 … success and 1 … failure". Each
 * returned span is still parsed by the authoritative keyword regexes downstream.
 */
export async function segmentCommands(prompt: string): Promise<string[]> {
  if (hasCashXml(prompt)) return [prompt];
  const det = splitInstructions(prompt);
  if (det.length >= 2) return det;
  try {
    const out = await converseJson<{ commands?: unknown }>(prompt, {
      system: SEGMENT_SYSTEM,
      temperature: 0,
    });
    const cmds = Array.isArray(out.commands)
      ? out.commands.map((c) => String(c).trim()).filter(Boolean)
      : [];
    if (cmds.length >= 2) return cmds;
  } catch {
    /* fall through to the single deterministic segment */
  }
  return det;
}

/**
 * Build a SimulateRequest from a natural-language message + the supervisor's
 * routing decision. count/startMessageId come from the LLM (regex fallback);
 * the sample template is the pasted XML if present, else the built-in one.
 */
export function buildSimulateRequest(message: string, route: RouteDecision): SimulateRequest {
  const p = route.parameters;
  return SimulateRequest.parse({
    application:
      route.targetApplication?.trim() ||
      (typeof p.application === 'string' ? p.application.trim() : '') ||
      'cashMessage',
    samples: hasCashXml(message) ? message : DEFAULT_CASHMESSAGE_SAMPLES,
    sinks: (Array.isArray(p.sinks) ? p.sinks : undefined) ?? (route.sources.length ? route.sources : ['cloudwatch']),
    count: parseCount(message, p.count),
    messageTypes: parseMessageTypes(message),
    ackStatus: parseAckStatus(message),
    startMessageId: parseStartId(message, p.startMessageId),
    spreadMinutes: Number(p.spreadMinutes ?? 0),
    logGroup:
      (typeof p.logGroup === 'string' ? p.logGroup : undefined) ?? parseLogGroup(message),
  });
}

/** One simulation command as understood from the user's request. */
export interface SimulateCommand {
  count: number;
  messageTypes: ('REQUEST' | 'ACK' | 'RESPONSE')[];
  ackStatus: 'success' | 'failure';
  startMessageId?: string;
  application?: string;
  /** Target CloudWatch log group (from an explicit name or a content type). */
  logGroup?: string;
}

const EXTRACT_ONE_SYSTEM = `You convert ONE natural-language cashMessage simulation
command into structured parameters. Domain: an FRB cashMessage transaction has a
REQUEST and optionally an ACK and a RESPONSE, correlated by messageId.

Extract for THIS single command:
- count: integer number of sets/transactions to generate (default 1).
- messageTypes: subset of ["REQUEST","ACK","RESPONSE"] to generate per set.
  "request/ack/response" or unspecified -> all three; "without response" ->
  ["REQUEST","ACK"]; "request only" -> ["REQUEST"].
- ackStatus: "success" or "failure". "with failure"/"failed"/"reject"/"with error"
  -> "failure"; "success"/"no error"/"successful" -> "success". Default "success".
- startMessageId: the starting messageId if given (e.g. "001"), else null.

Respond ONLY with JSON:
{"count":int,"messageTypes":[...],"ackStatus":"success|failure","startMessageId":string|null}`;

function normalizeCommand(c: Record<string, unknown>): SimulateCommand {
  const rawTypes = Array.isArray(c.messageTypes) ? c.messageTypes : [];
  const types = rawTypes
    .map((t) => String(t).toUpperCase())
    .filter((t): t is 'REQUEST' | 'ACK' | 'RESPONSE' => ['REQUEST', 'ACK', 'RESPONSE'].includes(t));
  const sid = typeof c.startMessageId === 'string' && c.startMessageId.trim() ? c.startMessageId.trim() : undefined;
  return {
    count: Math.max(1, Math.floor(Number(c.count) || 1)),
    messageTypes: types.length ? types : ['REQUEST', 'ACK', 'RESPONSE'],
    ackStatus: c.ackStatus === 'failure' ? 'failure' : 'success',
    startMessageId: sid,
    application: typeof c.application === 'string' ? c.application : undefined,
  };
}

/** Unambiguous success/failure keyword in the text (not negated). */
function explicitAck(seg: string): 'success' | 'failure' | undefined {
  const m = seg.toLowerCase();
  const failure =
    /(?<!\b(?:no|without|zero|not)\s+)(fail(?:ure|ed)?|reject(?:ed)?|\bnack\b|unsuccessful|declined|with\s+error)/.test(m);
  if (failure) return 'failure';
  if (/\b(success(ful)?|no error|no fail)/.test(m)) return 'success';
  return undefined;
}

/**
 * Understand ONE command with the LLM, then let unambiguous deterministic
 * signals win so the model can't flip them (success/failure, "without response").
 */
async function extractOneCommand(seg: string): Promise<SimulateCommand> {
  const rxTypes = parseMessageTypes(seg);
  const rxCount = parseCount(seg, undefined);
  const rxStart = parseStartId(seg, undefined);
  const rxAck = explicitAck(seg);

  let llm: SimulateCommand | undefined;
  try {
    llm = normalizeCommand(
      await converseJson<Record<string, unknown>>(seg, { system: EXTRACT_ONE_SYSTEM, temperature: 0 }),
    );
  } catch {
    /* llm stays undefined */
  }

  return {
    count: rxCount || llm?.count || 1,
    // An explicit "without X"/"request only" (rxTypes < 3) is authoritative.
    messageTypes: rxTypes.length < 3 ? rxTypes : llm?.messageTypes ?? rxTypes,
    // Explicit success/failure keyword wins; else trust the LLM.
    ackStatus: rxAck ?? llm?.ackStatus ?? 'success',
    startMessageId: rxStart ?? llm?.startMessageId,
    logGroup: parseLogGroup(seg),
  };
}

/**
 * Split the prompt deterministically into one command per "simulate", then have
 * the LLM understand each single command. Splitting per-command (not one big LLM
 * call) prevents the model from merging/mixing multiple instructions.
 */
export async function extractCommands(prompt: string): Promise<SimulateCommand[]> {
  if (hasCashXml(prompt)) {
    return [
      {
        count: parseCount(prompt, undefined),
        messageTypes: parseMessageTypes(prompt),
        ackStatus: parseAckStatus(prompt),
        startMessageId: parseStartId(prompt, undefined),
        logGroup: parseLogGroup(prompt),
      },
    ];
  }
  const out: SimulateCommand[] = [];
  for (const seg of await segmentCommands(prompt)) out.push(await extractOneCommand(seg));
  return out;
}

function describe(c: SimulateCommand): string {
  const ack = c.ackStatus === 'failure' ? 'ack FAILED' : 'ack success';
  const ids = c.startMessageId ? ` from id ${c.startMessageId}` : '';
  const lg = c.logGroup ? ` -> ${c.logGroup}` : '';
  return `${c.count} × ${c.messageTypes.join('+')}, ${ack}${ids}${lg}`;
}

/** What the simulator produced for one command, plus how it was understood. */
export interface SimulatePromptOutcome {
  instruction: string;
  spec: SimulateCommand;
  result: SimulateResult;
}

/**
 * Natural-language simulate path for the Simulator UI. The LLM parses the prompt
 * into structured commands; each runs independently so params don't bleed across
 * commands. (buildSimulateRequest/RouteDecision remain for the chatbot path.)
 */
export async function handleSimulatePrompt(
  input: unknown,
): Promise<{ results: SimulatePromptOutcome[] }> {
  const { prompt } = z.object({ prompt: z.string().min(1) }).parse(input);
  // Pasted XML is the template; the prose lines are the commands. Parse each
  // from its own text so "(4) success" and "(5) failure" don't merge.
  const { samples: xmlSamples, instructions } = separateSamplesAndInstructions(prompt);
  const samples = xmlSamples && hasCashXml(xmlSamples) ? xmlSamples : DEFAULT_CASHMESSAGE_SAMPLES;
  const commandText = instructions || prompt;
  // A target log group named once for the whole prompt applies to every command
  // that doesn't name its own.
  const promptLogGroup = parseLogGroup(commandText);
  const results: SimulatePromptOutcome[] = [];
  for (const spec of await extractCommands(commandText)) {
    spec.logGroup = spec.logGroup ?? promptLogGroup;
    const req = SimulateRequest.parse({
      application: spec.application ?? 'cashMessage',
      samples,
      sinks: ['cloudwatch'],
      count: spec.count,
      messageTypes: spec.messageTypes,
      ackStatus: spec.ackStatus,
      startMessageId: spec.startMessageId,
      spreadMinutes: 0,
      logGroup: spec.logGroup,
    });
    const result = await simulate(req);
    results.push({ instruction: describe(spec), spec, result });
  }
  return { results };
}
