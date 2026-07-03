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
using ONLY the provided log aggregates and sample lines for the given time window.
When the question asks "how many", give the exact number from the aggregates. If
the data is insufficient, say what is missing. Never invent counts. Be concise.`;

/** Count messageType occurrences (works for the FRB cashMessage XML logs). */
function messageTypeOf(log: ParsedLog): string | undefined {
  const m = log.raw.match(/<(?:[\w.-]+:)?messageType>\s*([^<]+?)\s*<\/(?:[\w.-]+:)?messageType>/i);
  if (m) return m[1]!.toUpperCase();
  const f = log.fields?.messageType;
  return typeof f === 'string' ? f.toUpperCase() : undefined;
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
  for (const l of parsed) {
    const mt = messageTypeOf(l);
    if (mt) byMessageType[mt] = (byMessageType[mt] ?? 0) + 1;
    byLevel[l.level] = (byLevel[l.level] ?? 0) + 1;
  }

  const summary = [
    `Source: ${source}`,
    `Window: last ${windowMinutes} minute(s) (since ${new Date(since).toISOString()})`,
    `Total log entries: ${parsed.length}`,
    `Count by messageType: ${JSON.stringify(byMessageType)}`,
    `Count by level: ${JSON.stringify(byLevel)}`,
  ].join('\n');

  const sample = parsed
    .slice(0, 25)
    .map((l) => `[${new Date(l.timestamp).toISOString()}] ${l.level} ${l.message.slice(0, 160)}`)
    .join('\n');

  const answer = await converse(
    `QUESTION: ${message}\n\nAGGREGATES:\n${summary}\n\nSAMPLE LOG LINES:\n${sample || '(none)'}`,
    { system: ANALYZE_SYSTEM, temperature: 0 },
  );

  return {
    answer,
    logs: parsed.slice(0, 50),
    meta: { source, windowMinutes, total: parsed.length, byMessageType, byLevel },
  };
}
