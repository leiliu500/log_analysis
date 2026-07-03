import { z } from 'zod';
import { SimulateRequest, type RouteDecision, type SimulateResult } from '@log/shared';
import { converseJson } from '@log/analysis';
import { simulate, DEFAULT_CASHMESSAGE_SAMPLES } from '@log/simulator';

/**
 * How many sets to generate. The explicit "N request/ack/response/sets" phrase
 * in the text wins over the LLM (it confuses id ranges like "001 to 004" with
 * the set count); the LLM value is only a fallback.
 */
export function parseCount(message: string, fromLlm: unknown): number {
  const m = message.match(/\b(\d{1,4})\s*(?:request|ack|response|set|message|msg|log|transaction)/i);
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

/**
 * Split a prompt containing several "simulate …" commands into one segment per
 * command, so each is parsed with its own count/types/ackStatus. A prompt with
 * one command (or pasted XML) returns a single segment. XML payloads are never
 * split (they contain no "simulate" keyword).
 */
export function splitInstructions(prompt: string): string[] {
  if (hasCashXml(prompt)) return [prompt];
  const idxs = [...prompt.matchAll(/\bsimulate\b/gi)]
    .map((m) => m.index)
    .filter((i): i is number => i !== undefined);
  if (idxs.length <= 1) return [prompt];
  const segs: string[] = [];
  for (let k = 0; k < idxs.length; k++) {
    const to = k + 1 < idxs.length ? idxs[k + 1]! : prompt.length;
    const seg = prompt.slice(idxs[k]!, to).trim();
    if (seg) segs.push(seg);
  }
  return segs.length ? segs : [prompt];
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
  });
}

/** One simulation command as understood from the user's request. */
export interface SimulateCommand {
  count: number;
  messageTypes: ('REQUEST' | 'ACK' | 'RESPONSE')[];
  ackStatus: 'success' | 'failure';
  startMessageId?: string;
  application?: string;
}

const EXTRACT_SYSTEM = `You convert a user's natural-language request into structured
cashMessage simulation commands. Domain: an FRB cashMessage transaction has a
REQUEST and optionally an ACK and a RESPONSE, correlated by messageId. A user may
give SEVERAL commands in one prompt (often numbered); return one object per
distinct command, in order.

For each command extract:
- count: integer number of sets/transactions to generate (default 1).
- messageTypes: subset of ["REQUEST","ACK","RESPONSE"] to generate per set.
  "request/ack/response" or unspecified -> all three; "without response" ->
  ["REQUEST","ACK"]; "request only" -> ["REQUEST"].
- ackStatus: "success" or "failure" (the ackCode on ACK/RESPONSE).
  "with failure"/"failed"/"reject"/"with error" -> "failure";
  "success"/"no error"/"successful" -> "success". Default "success".
- startMessageId: the starting messageId if the user gives one (e.g. "001"), else null.

Respond ONLY with JSON:
{"commands":[{"count":int,"messageTypes":[...],"ackStatus":"success|failure","startMessageId":string|null}]}`;

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

/**
 * Use the LLM to understand the request and extract one or more simulation
 * commands. Falls back to deterministic regex parsing if the model is
 * unavailable or returns nothing usable.
 */
export async function extractCommands(prompt: string): Promise<SimulateCommand[]> {
  if (!hasCashXml(prompt)) {
    try {
      const raw = await converseJson<{ commands?: Record<string, unknown>[] }>(prompt, {
        system: EXTRACT_SYSTEM,
        temperature: 0,
      });
      const cmds = (raw.commands ?? []).map(normalizeCommand);
      if (cmds.length) return cmds;
    } catch {
      /* fall back to regex below */
    }
  }
  return splitInstructions(prompt).map((seg) => ({
    count: parseCount(seg, undefined),
    messageTypes: parseMessageTypes(seg),
    ackStatus: parseAckStatus(seg),
    startMessageId: parseStartId(seg, undefined),
  }));
}

function describe(c: SimulateCommand): string {
  const ack = c.ackStatus === 'failure' ? 'ack FAILED' : 'ack success';
  const ids = c.startMessageId ? ` from id ${c.startMessageId}` : '';
  return `${c.count} × ${c.messageTypes.join('+')}, ${ack}${ids}`;
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
  const samples = hasCashXml(prompt) ? prompt : DEFAULT_CASHMESSAGE_SAMPLES;
  const results: SimulatePromptOutcome[] = [];
  for (const spec of await extractCommands(prompt)) {
    const req = SimulateRequest.parse({
      application: spec.application ?? 'cashMessage',
      samples,
      sinks: ['cloudwatch'],
      count: spec.count,
      messageTypes: spec.messageTypes,
      ackStatus: spec.ackStatus,
      startMessageId: spec.startMessageId,
      spreadMinutes: 0,
    });
    const result = await simulate(req);
    results.push({ instruction: describe(spec), spec, result });
  }
  return { results };
}
