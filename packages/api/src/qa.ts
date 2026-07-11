import type {
  RouteDecision,
  ParsedLog,
  ApplicationDef,
  AssistantMeta,
  TransactionProtocol,
} from '@log/shared';
import { loadPrompt } from '@log/shared';
import { converse, parseBatch } from '@log/analysis';
import { connectorFor } from '@log/ingestion';
import { applicationRegistry } from '@log/agents';

/** Parse a time window (in minutes) from the question or the LLM's param. */
export function extractWindowMinutes(message: string, fromLlm: unknown): number {
  if (typeof fromLlm === 'number' && fromLlm > 0) return Math.floor(fromLlm);
  if (typeof fromLlm === 'string' && /^\d+$/.test(fromLlm)) return Number(fromLlm);
  const m = message.match(/(?:recent|last|past|within|latest)\s+(\d+)\s*(minute|min|hour|hr|day)s?/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2]!.toLowerCase();
    if (unit.startsWith('hour') || unit === 'hr') return n * 60;
    if (unit.startsWith('day')) return n * 1440;
    return n;
  }
  return 60;
}

/** Generic fallback prompt when the resolved application declares none. */
const GENERIC_SYSTEM = loadPrompt('api/qa.md');

/**
 * The application the Log Assistant answers for — resolved dynamically from the
 * user's question (an explicit targetApplication, else a named log group /
 * keyword, else the first installed app). This is what makes the assistant
 * application-specific: SCP and apiflc questions load their own prompt +
 * correlation model.
 */
export function resolveApp(message: string, route: RouteDecision): ApplicationDef {
  const explicit =
    route.targetApplication ??
    (typeof route.parameters?.application === 'string' ? (route.parameters.application as string) : undefined);
  return (
    applicationRegistry.byId(explicit) ??
    applicationRegistry.matchLogGroup(message)?.app ??
    applicationRegistry.all()[0]!
  );
}

/**
 * Per-application extraction of a log's assistant view. Uses the app's own
 * {@link ApplicationDef.assistantMeta} (SCP's richer messageId view) when
 * present, else derives it from the transaction protocol's event (id = corrId).
 */
function metaFor(app: ApplicationDef): (log: ParsedLog) => AssistantMeta {
  if (app.assistantMeta) return (log) => app.assistantMeta!(log) ?? {};
  return (log) => {
    const ev = app.protocol.eventOf(log);
    return ev ? { type: ev.type, id: ev.corrId, corrId: ev.corrId, ackCode: ev.ackCode } : {};
  };
}

export interface LogAnswer {
  answer: string;
  logs: ParsedLog[];
  meta: {
    source: string;
    application: string;
    windowMinutes: number;
    total: number;
    byMessageType: Record<string, number>;
    byLevel: Record<string, number>;
  };
}

type Enriched = { log: ParsedLog; meta: AssistantMeta };

const isFailAck = (proto: TransactionProtocol, c?: string): boolean => !!c && !proto.isSuccess(c);

const tsOf = (e: Enriched): string => new Date(e.log.timestamp).toISOString();
/** One line describing a message: own id, correlation id (when different), ackCode. */
const fmt = (e: Enriched, label: string): string =>
  `- ${tsOf(e)} ${e.meta.type ?? e.log.level.toUpperCase()} ${label}=${e.meta.id ?? '-'}` +
  `${e.meta.corrId && e.meta.corrId !== e.meta.id ? `, initMessageId=${e.meta.corrId}` : ''}` +
  `${e.meta.ackCode ? `, ackCode=${e.meta.ackCode}` : ''}`;

/** A request correlated with its follow-up phases, grouped by correlation id. */
interface Tx {
  corrId: string;
  /** phase name -> the messages seen for it (e.g. REQUEST, ACK, RESPONSE). */
  phases: Map<string, Enriched[]>;
}

/** Correlate all transaction messages by their correlation id (protocol-agnostic). */
function correlate(enriched: Enriched[]): Map<string, Tx> {
  const map = new Map<string, Tx>();
  for (const e of enriched) {
    if (!e.meta.type || !e.meta.corrId) continue;
    let t = map.get(e.meta.corrId);
    if (!t) map.set(e.meta.corrId, (t = { corrId: e.meta.corrId, phases: new Map() }));
    const arr = t.phases.get(e.meta.type) ?? [];
    arr.push(e);
    t.phases.set(e.meta.type, arr);
  }
  return map;
}

/** Which phase(s) the question is about, from the app's own phase names. */
export function askedTypes(message: string, allPhases: readonly string[]): string[] {
  const m = message.toLowerCase();
  const out: string[] = [];
  for (const p of allPhases) {
    const w = p.toLowerCase();
    const re = w === 'ack' ? /\backs?\b|acknowledg/ : new RegExp(`\\b${w}s?\\b`);
    if (re.test(m)) out.push(p);
  }
  return out;
}

/**
 * Answer count / list / failure / completeness questions DETERMINISTICALLY from
 * the parsed logs — never via the LLM — so ids and counts are always the real
 * ones in the window. Protocol-driven: correlation is by corrId, phases and
 * success come from the application's protocol, ids are labelled by the app's
 * correlationLabel. Returns null for open-ended questions (grounded LLM path).
 */
export function directAnswer(
  message: string,
  source: string,
  windowMinutes: number,
  enriched: Enriched[],
  proto: TransactionProtocol,
  label = 'messageId',
): string | null {
  const m = message.toLowerCase();
  const win = `the last ${windowMinutes} minute(s)`;
  const allPhases = proto.allPhases;
  const followups = proto.phases; // non-initial phases

  // (a) A specific id mentioned → describe that transaction end-to-end.
  const mentions = (id: string | undefined): id is string => {
    if (!id || id.length < 3) return false;
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9._-])${esc}([^A-Za-z0-9._-]|$)`).test(message);
  };
  const explicitId = message.match(/(?:message|correlation)[_\s-]?id\s*[=:]?\s*([A-Za-z0-9][A-Za-z0-9._-]{2,})/i)?.[1];
  const corrIds = [...new Set(enriched.map((e) => e.meta.corrId).filter(Boolean) as string[])];
  const ownIds = enriched.map((e) => e.meta.id).filter(Boolean) as string[];
  const mentioned = explicitId ?? corrIds.find(mentions) ?? ownIds.find(mentions);
  if (mentioned) {
    const txs = correlate(enriched);
    const t =
      txs.get(mentioned) ??
      [...txs.values()].find((x) => [...x.phases.values()].flat().some((e) => e.meta.id === mentioned));
    if (!t) return `No message with ${label}=${mentioned} was found on ${source} in ${win}.`;
    const parts: string[] = [];
    let anyFollowupFailed = false;
    let missingFollowup = false;
    for (const phase of allPhases) {
      const msgs = t.phases.get(phase) ?? [];
      if (!msgs.length) {
        parts.push(`${phase} ✗`);
        if (followups.includes(phase)) missingFollowup = true;
        continue;
      }
      const codes = msgs.map((e) => e.meta.ackCode).filter(Boolean);
      const codeStr = codes.length ? ` (ackCode=${codes.join(', ')})` : '';
      parts.push(`${phase} ✓${codeStr}`);
      if (msgs.some((e) => isFailAck(proto, e.meta.ackCode))) anyFollowupFailed = true;
    }
    const note = anyFollowupFailed
      ? ' — this transaction has a FAILED response.'
      : missingFollowup && t.phases.size > 1
        ? ' — this transaction is incomplete (a follow-up phase is missing).'
        : '';
    const detail = [...t.phases.values()].flat().filter((e) => e.meta.type !== proto.initial);
    return [`${label}=${t.corrId}: ${parts.join(', ')}.${note}`, '', ...detail.map((e) => fmt(e, label))]
      .join('\n')
      .trim();
  }

  // (b) Failure / error questions → messages with a non-success ackCode.
  if (/\b(exception|errors?|failure|failures|failed|faults?|reject(ed)?|nack|unsuccessful|declined|problems?)\b/.test(m)) {
    const failed = enriched.filter((e) => isFailAck(proto, e.meta.ackCode));
    const coded = enriched.filter((e) => e.meta.ackCode).length;
    if (!failed.length) {
      return `No — no failures/errors on ${source} in ${win}. All ${coded} ackCode(s) indicate success.`;
    }
    return [`Yes — ${failed.length} message(s) with a failed ackCode on ${source} in ${win}:`, '', ...failed.map((e) => fmt(e, label))].join('\n');
  }

  // (c) Completeness: transactions with the request but a missing follow-up phase.
  if (
    /(incomplete|only\s+(has\s+)?ack|(ack|request)\s+(but|and|with)?\s*(no|without|missing)\s+response|(no|without|missing)\s+response|which\s+(message|request|transaction|one).*(no|without|only|missing))/.test(
      m,
    )
  ) {
    const txs = correlate(enriched);
    const incomplete = [...txs.values()].filter(
      (t) => t.phases.has(proto.initial) && followups.some((p) => !t.phases.has(p)) && t.phases.size > 1,
    );
    if (!incomplete.length) {
      return `No — every request that started a transaction also completed its follow-up phase(s) on ${source} in ${win}.`;
    }
    const lines = [`${incomplete.length} incomplete transaction(s) on ${source} in ${win}:`, ''];
    for (const t of incomplete) {
      const present = allPhases.filter((p) => t.phases.has(p));
      const missing = followups.filter((p) => !t.phases.has(p));
      lines.push(`- ${label}=${t.corrId} — ${present.join('+')} present, ${missing.map((p) => `no ${p}`).join(', ')}`);
    }
    return lines.join('\n');
  }

  const isCount = /\bhow many\b|\bnumber of\b|\bcount\b|\btotal\b/.test(m);
  const wantsIds = /messageid|message id|correlationid|correlation id|\bids?\b|list|show|which|what are/.test(m);
  if (!isCount && !wantsIds) return null;

  const types = askedTypes(message, allPhases);
  const matched = types.length ? enriched.filter((e) => e.meta.type && types.includes(e.meta.type)) : enriched.filter((e) => e.meta.type);

  if (matched.length === 0) {
    const what = types.length ? `${types.join('/')} messages` : 'transaction messages';
    return `No ${what} were found on ${source} in ${win}.`;
  }

  const header =
    types.length > 1
      ? `${matched.length} messages (${types.map((t) => `${matched.filter((e) => e.meta.type === t).length} ${t}`).join(', ')}) on ${source} in ${win}.`
      : `${matched.length} ${types[0] ? `${types[0]} message(s)` : 'transaction message(s)'} on ${source} in ${win}.`;

  const lines = [header];
  const ids = matched.map((e) => e.meta.id).filter((x): x is string => !!x && x !== '-');
  if ((wantsIds || matched.length <= 50) && ids.length) {
    lines.push('');
    for (const e of matched.slice(0, 200)) lines.push(fmt(e, label));
  }
  return lines.join('\n');
}

/**
 * The Log Assistant's core skill, application-specific: resolve the target app,
 * pull raw logs over a recent window, compute deterministic aggregates via the
 * app's protocol, and answer grounded in them — loading the app's own prompt.
 */
export async function answerLogQuestion(message: string, route: RouteDecision): Promise<LogAnswer> {
  const app = resolveApp(message, route);
  const proto = app.protocol;
  const label = app.correlationLabel ?? 'messageId';
  const system = app.assistantPromptPath ? loadPrompt(app.assistantPromptPath) : GENERIC_SYSTEM;

  const source = route.sources[0] ?? 'cloudwatch';
  const p = route.parameters;
  const windowMinutes = extractWindowMinutes(message, p.windowMinutes ?? p.minutes);
  const since = Date.now() - windowMinutes * 60_000;

  const records = await connectorFor(source).pull({ since, limit: 5000 });
  const parsed = parseBatch(records);

  const meta = metaFor(app);
  const enriched = parsed.map((l) => ({ log: l, meta: meta(l) }));
  const byMessageType: Record<string, number> = {};
  const byLevel: Record<string, number> = {};
  for (const { log, meta: mt } of enriched) {
    if (mt.type) byMessageType[mt.type] = (byMessageType[mt.type] ?? 0) + 1;
    byLevel[log.level] = (byLevel[log.level] ?? 0) + 1;
  }

  const answerMeta = { source, application: app.id, windowMinutes, total: parsed.length, byMessageType, byLevel };

  // Deterministic path first — ids/counts are the real ones.
  const direct = directAnswer(message, source, windowMinutes, enriched, proto, label);
  if (direct !== null) {
    return { answer: direct, logs: parsed.slice(0, 50), meta: answerMeta };
  }

  const summary = [
    `Application: ${app.displayName} (${app.id})`,
    `Source: ${source}`,
    `Window: last ${windowMinutes} minute(s) (since ${new Date(since).toISOString()})`,
    `Total log entries: ${parsed.length}`,
    `Count by messageType: ${JSON.stringify(byMessageType)}`,
    `Count by level: ${JSON.stringify(byLevel)}`,
  ].join('\n');
  const table = enriched
    .slice(0, 500)
    .filter((e) => e.meta.type)
    .map((e) => fmt(e, label).replace(/^- /, ''))
    .join('\n');

  const answer = await converse(
    `QUESTION: ${message}\n\nAGGREGATES:\n${summary}\n\nMESSAGES (one per line, with ids):\n${table || '(none)'}`,
    { system, temperature: 0, maxTokens: 2500 },
  );

  return { answer, logs: parsed.slice(0, 50), meta: answerMeta };
}
