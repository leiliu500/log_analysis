import { z } from 'zod';

/** All supported log sources. Extend here to add new source types. */
export const LogSourceType = z.enum(['cloudwatch', 'splunk', 'grafana', 'email']);
export type LogSourceType = z.infer<typeof LogSourceType>;

export const LogLevel = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'unknown']);
export type LogLevel = z.infer<typeof LogLevel>;

/**
 * A raw log record as pulled from a source, before parsing.
 * `raw` is the untouched line/document; everything else is envelope metadata.
 */
export const RawLogRecord = z.object({
  source: LogSourceType,
  /** Logical stream: CW log group/stream, Splunk index, Loki stream, mailbox. */
  stream: z.string(),
  /** Source-native timestamp in epoch millis. */
  timestamp: z.number().int(),
  raw: z.string(),
  /** Source-native metadata (log group, host, labels, message-id, ...). */
  attributes: z.record(z.string(), z.unknown()).default({}),
});
export type RawLogRecord = z.infer<typeof RawLogRecord>;

/** A parsed/structured log record produced by the analysis engine. */
export const ParsedLog = z.object({
  id: z.string().uuid(),
  source: LogSourceType,
  stream: z.string(),
  timestamp: z.number().int(),
  level: LogLevel,
  message: z.string(),
  /** Named fields extracted from the message (status, latencyMs, userId, ...). */
  fields: z.record(z.string(), z.unknown()).default({}),
  /** Entities discovered (ip, host, service, requestId, errorCode, ...). */
  entities: z.record(z.string(), z.array(z.string())).default({}),
  /** Signature/fingerprint for grouping structurally identical logs. */
  fingerprint: z.string(),
  raw: z.string(),
  ingestedAt: z.number().int(),
  /** Vector embedding of level+message for semantic retrieval (optional). */
  embedding: z.array(z.number()).optional(),
});
export type ParsedLog = z.infer<typeof ParsedLog>;

export const LogBatch = z.object({
  batchId: z.string().uuid(),
  source: LogSourceType,
  records: z.array(RawLogRecord),
});
export type LogBatch = z.infer<typeof LogBatch>;
