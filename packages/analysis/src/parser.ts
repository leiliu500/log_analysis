import { randomUUID } from 'node:crypto';
import type { ParsedLog, RawLogRecord } from '@log/shared';
import { detectLevel, extractEntities, extractNumericFields } from './extract.js';
import { fingerprint } from './fingerprint.js';

/** Attempt structured parse (JSON, then logfmt); fall back to raw text. */
function structuredParse(raw: string): {
  message: string;
  fields: Record<string, unknown>;
  level?: string;
} {
  const trimmed = raw.trim();

  // JSON logs
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const message =
        (obj.message as string) ??
        (obj.msg as string) ??
        (obj.log as string) ??
        trimmed;
      const level = (obj.level as string) ?? (obj.severity as string) ?? undefined;
      return { message: String(message), fields: obj, level };
    } catch {
      /* fall through */
    }
  }

  // logfmt: key=value pairs
  const kv = [...trimmed.matchAll(/(\w[\w.-]*)=("[^"]*"|'[^']*'|\S+)/g)];
  if (kv.length >= 2) {
    const fields: Record<string, unknown> = {};
    for (const m of kv) fields[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
    const message =
      (fields.msg as string) ?? (fields.message as string) ?? trimmed;
    return { message: String(message), fields, level: fields.level as string };
  }

  return { message: trimmed, fields: {} };
}

/** Parse one raw record into a structured ParsedLog. Pure & synchronous. */
export function parseRecord(rec: RawLogRecord): ParsedLog {
  const { message, fields, level } = structuredParse(rec.raw);
  const numeric = extractNumericFields(rec.raw);
  const entities = extractEntities(rec.raw);
  return {
    id: randomUUID(),
    source: rec.source,
    stream: rec.stream,
    timestamp: rec.timestamp,
    level: detectLevel(rec.raw, level),
    message,
    fields: { ...fields, ...numeric, ...rec.attributes },
    entities,
    fingerprint: fingerprint(message),
    raw: rec.raw,
    ingestedAt: Date.now(),
  };
}

export function parseBatch(records: RawLogRecord[]): ParsedLog[] {
  return records.map(parseRecord);
}
