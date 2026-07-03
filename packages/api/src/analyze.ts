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
  return 15;
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
} {
  const type = xmlTag(log.raw, 'messageType')?.toUpperCase() ?? (typeof log.fields?.messageType === 'string' ? (log.fields.messageType as string).toUpperCase() : undefined);
  return { type, messageId: xmlTag(log.raw, 'messageId'), initMessageId: xmlTag(log.raw, 'initMessageId') };
}

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

  // Per-message table (with ids) so the model can list messageIds when asked.
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
