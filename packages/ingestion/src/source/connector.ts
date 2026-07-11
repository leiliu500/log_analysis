import type { RawLogRecord, LogSourceType } from '@log/shared';

export interface PullOptions {
  /** Fetch logs at or after this epoch-ms timestamp. */
  since: number;
  /** Fetch logs up to this epoch-ms timestamp (default: now). */
  until?: number;
  /** Max records to return. */
  limit?: number;
  /** Optional source-specific filter/query string. */
  query?: string;
}

/**
 * Every log source implements this interface. New sources (requirement 2's
 * "etc.") only need a new LogConnector — the analysis pipeline is source-agnostic.
 */
export interface LogConnector {
  readonly source: LogSourceType;
  /** Pull a bounded batch of raw records. */
  pull(opts: PullOptions): Promise<RawLogRecord[]>;
  /** Optional: write logs to this source (used by the simulator). */
  write?(records: RawLogRecord[]): Promise<number>;
}
