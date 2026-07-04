import type { RouteDecision, ParsedLog } from '@log/shared';
import { converse, parseBatch } from '@log/analysis';
import { connectorFor } from '@log/ingestion';

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

const ANALYZE_SYSTEM = `You are the log-analysis agent. Answer the user's question
using ONLY the provided AGGREGATES and the MESSAGES table for the given time
window. When asked "how many", give the exact number from the aggregates. When
asked to list/show messageId (or initMessageId), read them from the MESSAGES
table and list each one (e.g. as a bulleted list). Never invent values. If the
data is insufficient, say what is missing. Be concise.`;

function xmlTag(raw: string, tag: string): string | undefined {
  const m = raw.match(new RegExp(`<(?:[\\w.-]+:)?${tag}>\\s*([^<]+?)\\s*</(?:[\\w.-]+:)?${tag}>`, 'i'));
  return m ? m[1] : undefined;
}

/** Message metadata pulled from the FRB cashMessage XML logs. */
function metaOf(log: ParsedLog): {
  type?: string;
  messageId?: string;
  initMessageId?: string;
  ackCode?: string;
} {
  const type = xmlTag(log.raw, 'messageType')?.toUpperCase() ?? (typeof log.fields?.messageType === 'string' ? (log.fields.messageType as string).toUpperCase() : undefined);
  return {
    type,
    messageId: xmlTag(log.raw, 'messageId'),
    initMessageId: xmlTag(log.raw, 'initMessageId'),
    ackCode: xmlTag(log.raw, 'ackCode'),
  };
}

/** An ackCode present and NOT a success code counts as a failure. */
const isSuccessAck = (c?: string): boolean =>
  !!c && /^(ok|success(ful)?|processed(_successfully)?|accepted|complete[d]?)/i.test(c.trim());
const isFailAck = (c?: string): boolean => !!c && !isSuccessAck(c);

export interface LogAnswer {
  answer: string;
  logs: ParsedLog[];
  meta: {
    source: string;
    windowMinutes: number;
    total: number;
    byMessageType: Record<string, number>;
    byLevel: Record<string, number>;
  };
}

type Meta = { type?: string; messageId?: string; initMessageId?: string; ackCode?: string };
type Enriched = { log: ParsedLog; meta: Meta };

const ts = (e: Enriched): string => new Date(e.log.timestamp).toISOString();
const fmt = (e: Enriched): string =>
  `- ${ts(e)} ${e.meta.type ?? e.log.level.toUpperCase()} messageId=${e.meta.messageId ?? '-'}` +
  `${e.meta.initMessageId ? `, initMessageId=${e.meta.initMessageId}` : ''}` +
  `${e.meta.ackCode ? `, ackCode=${e.meta.ackCode}` : ''}`;

/** One request correlated with its ACK/RESPONSE messages (by initMessageId). */
interface Tx {
  reqId: string;
  hasReq: boolean;
  acks: Enriched[];
  responses: Enriched[];
}

/** Correlate REQUEST ↔ ACK/RESPONSE by messageId/initMessageId. */
function correlate(enriched: Enriched[]): Map<string, Tx> {
  const map = new Map<string, Tx>();
  const get = (id: string): Tx => {
    let t = map.get(id);
    if (!t) map.set(id, (t = { reqId: id, hasReq: false, acks: [], responses: [] }));
    return t;
  };
  for (const e of enriched) {
    if (e.meta.type === 'REQUEST' && e.meta.messageId) get(e.meta.messageId).hasReq = true;
    else if (e.meta.type === 'ACK' && e.meta.initMessageId) get(e.meta.initMessageId).acks.push(e);
    else if (e.meta.type === 'RESPONSE' && e.meta.initMessageId) get(e.meta.initMessageId).responses.push(e);
  }
  return map;
}

type MsgType = 'REQUEST' | 'ACK' | 'RESPONSE';

/**
 * Which cashMessage type(s) the question is about. A question may name several
 * ("ACK and responses" → both), so this returns every type mentioned; an empty
 * result means "all types" (e.g. "how many messages/logs").
 */
export function askedTypes(message: string): MsgType[] {
  const m = message.toLowerCase();
  const t: MsgType[] = [];
  if (/\brequests?\b/.test(m)) t.push('REQUEST');
  if (/\backs?\b|acknowledg/.test(m)) t.push('ACK');
  if (/\bresponses?\b/.test(m)) t.push('RESPONSE');
  return t;
}

/**
 * Answer count / "list messageId" questions DETERMINISTICALLY from the parsed
 * logs — never via the LLM — so the ids and counts are always the real ones in
 * the window (the model otherwise fabricates plausible-looking ids). Returns
 * null for open-ended questions, which fall through to the grounded LLM path.
 */
export function directAnswer(
  message: string,
  source: string,
  windowMinutes: number,
  enriched: Enriched[],
): string | null {
  const m = message.toLowerCase();
  const win = `the last ${windowMinutes} minute(s)`;

  // (a) A specific messageId mentioned → describe that transaction end-to-end.
  // Require a whole-token, length>=3 match so short ids don't match inside words.
  const mentionsId = (id: string | undefined): id is string => {
    if (!id || id.length < 3) return false;
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9._-])${esc}([^A-Za-z0-9._-]|$)`).test(message);
  };
  const reqIds = enriched.filter((e) => e.meta.type === 'REQUEST').map((e) => e.meta.messageId);
  const allIds = enriched.map((e) => e.meta.messageId);
  const mentioned = reqIds.find(mentionsId) ?? allIds.find(mentionsId);
  if (mentioned) {
    const txs = correlate(enriched);
    const t = txs.get(mentioned);
    const self = enriched.find((e) => e.meta.messageId === mentioned);
    if (!t && !self) return `No message with messageId=${mentioned} was found on ${source} in ${win}.`;
    const acks = t?.acks ?? [];
    const resps = t?.responses ?? [];
    const ackPart = acks.length
      ? `ACK ✓ (ackCode=${acks.map((e) => e.meta.ackCode ?? '-').join(', ')})`
      : 'ACK ✗';
    const respPart = resps.length
      ? `RESPONSE ✓ (ackCode=${resps.map((e) => e.meta.ackCode ?? '-').join(', ')})`
      : 'RESPONSE ✗';
    const reqPart = t?.hasReq || self?.meta.type === 'REQUEST' ? 'REQUEST ✓' : 'REQUEST ✗';
    const ackFailed = acks.some((e) => isFailAck(e.meta.ackCode));
    const note =
      acks.length && !resps.length
        ? ackFailed
          ? ' — this request has only a FAILED ACK and no RESPONSE.'
          : ' — this request has an ACK but no RESPONSE.'
        : '';
    return [`messageId=${mentioned}: ${reqPart}, ${ackPart}, ${respPart}.${note}`, '', ...[...acks, ...resps].map(fmt)]
      .join('\n')
      .trim();
  }

  // (b) Failure / error / exception questions → messages with a failed ackCode.
  if (/\b(exception|errors?|failure|failures|failed|faults?|reject(ed)?|nack|unsuccessful|declined|problems?)\b/.test(m)) {
    const failed = enriched.filter((e) => isFailAck(e.meta.ackCode));
    const ackCoded = enriched.filter((e) => e.meta.ackCode).length;
    if (!failed.length) {
      return `No — no failures/errors on ${source} in ${win}. All ${ackCoded} ACK/RESPONSE ackCode(s) indicate success.`;
    }
    return [`Yes — ${failed.length} message(s) with a failed ackCode on ${source} in ${win}:`, '', ...failed.map(fmt)].join('\n');
  }

  // (c) Completeness: which message has an ACK but NO RESPONSE (incomplete tx).
  if (
    /(incomplete|only\s+(has\s+)?ack|ack\s+(but|and|with)?\s*(no|without|missing)\s+response|(no|without|missing)\s+response|which\s+(message|request|one).*(no|without|only|missing))/.test(
      m,
    )
  ) {
    const txs = correlate(enriched);
    const incomplete = [...txs.values()].filter((t) => t.hasReq && t.acks.length > 0 && t.responses.length === 0);
    if (!incomplete.length) {
      return `No — every request that has an ACK also has a RESPONSE on ${source} in ${win}. No message has an ACK without a response.`;
    }
    const lines = [`${incomplete.length} message(s) with an ACK but NO RESPONSE on ${source} in ${win}:`, ''];
    for (const t of incomplete) {
      const codes = t.acks.map((e) => e.meta.ackCode ?? '-').join(', ');
      lines.push(`- messageId=${t.reqId} — ACK present (ackCode=${codes}), no RESPONSE`);
    }
    return lines.join('\n');
  }

  const isCount = /\bhow many\b|\bnumber of\b|\bcount\b|\btotal\b/.test(m);
  const wantsIds = /messageid|message id|\bids?\b|list|show|which|what are/.test(m);
  if (!isCount && !wantsIds) return null;

  const types = askedTypes(message);
  const matched = types.length
    ? enriched.filter((e) => e.meta.type && types.includes(e.meta.type as MsgType))
    : enriched;

  if (matched.length === 0) {
    const what = types.length ? `${types.join('/')} messages` : 'log entries';
    return `No ${what} were found on ${source} in ${win}.`;
  }

  // Header: when several types are asked, break the total down per type.
  const header =
    types.length > 1
      ? `${matched.length} messages (${types
          .map((t) => `${matched.filter((e) => e.meta.type === t).length} ${t}`)
          .join(', ')}) on ${source} in ${win}.`
      : `${matched.length} ${types[0] ? `${types[0]} message(s)` : 'log entr(y/ies)'} on ${source} in ${win}.`;

  const ids = matched.map((e) => e.meta.messageId).filter((x): x is string => !!x && x !== '-');
  const lines = [header];
  // List the ids (with timestamps) when asked, or whenever the set is small.
  if ((wantsIds || matched.length <= 50) && ids.length) {
    lines.push('');
    for (const e of matched.slice(0, 200)) {
      const ts = new Date(e.log.timestamp).toISOString();
      const init = e.meta.initMessageId ? `, initMessageId=${e.meta.initMessageId}` : '';
      lines.push(`- ${ts} ${e.meta.type ?? e.log.level.toUpperCase()} messageId=${e.meta.messageId ?? '-'}${init}`);
    }
  }
  return lines.join('\n');
}

/**
 * The analysis-agent's core skill: pull raw logs from a source over a recent
 * window, compute deterministic aggregates, and let the model answer the user's
 * question grounded in them (e.g. "how many requests in the last 5 minutes").
 */
export async function answerLogQuestion(
  message: string,
  route: RouteDecision,
): Promise<LogAnswer> {
  const source = route.sources[0] ?? 'cloudwatch';
  const p = route.parameters;
  const windowMinutes = extractWindowMinutes(message, p.windowMinutes ?? p.minutes);
  const since = Date.now() - windowMinutes * 60_000;

  const records = await connectorFor(source).pull({ since, limit: 5000 });
  const parsed = parseBatch(records);

  const byMessageType: Record<string, number> = {};
  const byLevel: Record<string, number> = {};
  const enriched = parsed.map((l) => ({ log: l, meta: metaOf(l) }));
  for (const { log, meta } of enriched) {
    if (meta.type) byMessageType[meta.type] = (byMessageType[meta.type] ?? 0) + 1;
    byLevel[log.level] = (byLevel[log.level] ?? 0) + 1;
  }

  const summary = [
    `Source: ${source}`,
    `Window: last ${windowMinutes} minute(s) (since ${new Date(since).toISOString()})`,
    `Total log entries: ${parsed.length}`,
    `Count by messageType: ${JSON.stringify(byMessageType)}`,
    `Count by level: ${JSON.stringify(byLevel)}`,
  ].join('\n');

  // Count / "list messageId" questions are answered deterministically from the
  // real logs so ids and counts are never fabricated by the model.
  const direct = directAnswer(message, source, windowMinutes, enriched);
  if (direct !== null) {
    return {
      answer: direct,
      logs: parsed.slice(0, 50),
      meta: { source, windowMinutes, total: parsed.length, byMessageType, byLevel },
    };
  }

  // Open-ended questions: let the model reason, but grounded in the real table.
  const table = enriched
    .slice(0, 500)
    .map(({ log, meta }) => {
      const init = meta.initMessageId ? ` initMessageId=${meta.initMessageId}` : '';
      return `[${new Date(log.timestamp).toISOString()}] ${meta.type ?? log.level.toUpperCase()} messageId=${meta.messageId ?? '-'}${init}`;
    })
    .join('\n');

  const answer = await converse(
    `QUESTION: ${message}\n\nAGGREGATES:\n${summary}\n\nMESSAGES (one per line, with ids):\n${table || '(none)'}`,
    { system: ANALYZE_SYSTEM, temperature: 0, maxTokens: 2500 },
  );

  return {
    answer,
    logs: parsed.slice(0, 50),
    meta: { source, windowMinutes, total: parsed.length, byMessageType, byLevel },
  };
}
