import type { ParsedLog } from './logs.js';

/**
 * Reassembling multi-line log entries.
 *
 * CloudWatch stores ONE EVENT PER PHYSICAL LINE, so a single logical log entry
 * arrives as several records. Two real consequences, both verified against
 * `/aws/lambda/adt-fca-d1-*`:
 *   - The handler's `... correlationID: 1234; Response from Data Services:` header
 *     and its `{ "result": ... }` body are separate events 1ms apart, and ONLY the
 *     header carries the correlationID — so selecting records by id yields a header
 *     with no content.
 *   - The authorizer's `REPORT RequestId: <id> ...` and `XRAY TraceId: 1-...` are
 *     separate events too, so no single record carries both the request id and the
 *     trace id — an id-join computed per record can never link them.
 * Coalescing records into entries before reading ids or content fixes both.
 */

/**
 * Does this raw line START a log entry, rather than continue the previous one?
 * An AWS Lambda / API-Gateway entry begins with an ISO timestamp, a
 * `(<gatewayRequestId>)` prefix, or a START/END/REPORT marker. Anything else — a
 * bare `{ "result": ... }`, `Payload: '...'`, `XRAY TraceId: ...` — is the tail of
 * the entry above it.
 */
const STARTS_ENTRY = /^\s*(\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s|\([A-Za-z0-9-]{8,}\)|(START|END|REPORT)\s+RequestId)/;
export const isContinuationLine = (raw: string): boolean => !STARTS_ENTRY.test(raw);

/** One logical log entry: its first record, every record it spans, and their joined text. */
export interface LogEntry {
  /** The record that starts the entry — carries its timestamp/level/ids. */
  head: ParsedLog;
  /** Every record in the entry, head first (the head alone for a single-line entry). */
  lines: ParsedLog[];
  /** The entry's full text: the head's raw plus each continuation line. */
  raw: string;
}

/**
 * Group log records into logical entries, attaching each continuation line to the
 * entry above it. Records are processed in timestamp order, and an entry never
 * spans streams (a continuation must come from the same stream as its head), so
 * interleaved groups cannot bleed into one another.
 *
 * `startsEntry` forces a record to begin a new entry regardless of its text, and
 * callers that know their records' shape SHOULD pass it: {@link isContinuationLine}
 * recognises AWS Lambda / API-Gateway line starts only, so a log in any other
 * format (SCP's `<ns2:cashMessage>` XML, say) looks like a continuation and two
 * consecutive messages in one stream would silently merge into a single entry.
 * Pass "is this record a transaction message?" and each one stays its own entry.
 */
export function coalesceEntries(logs: readonly ParsedLog[], startsEntry?: (log: ParsedLog) => boolean): LogEntry[] {
  const out: LogEntry[] = [];
  for (const log of [...logs].sort((a, b) => a.timestamp - b.timestamp)) {
    const last = out[out.length - 1];
    const continues = isContinuationLine(log.raw) && startsEntry?.(log) !== true;
    if (last && last.head.stream === log.stream && continues) {
      last.lines.push(log);
      last.raw += `\n${log.raw.trimEnd()}`;
    } else {
      out.push({ head: log, lines: [log], raw: log.raw.trimEnd() });
    }
  }
  return out;
}
