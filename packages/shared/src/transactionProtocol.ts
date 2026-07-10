import type { ParsedLog } from './logs.js';

/**
 * A single correlated message extracted from a log by a {@link TransactionProtocol}.
 * `type` is a protocol phase name (e.g. 'REQUEST' | 'ACK' | 'RESPONSE'); `corrId`
 * links every message of one transaction together.
 */
export interface TxEvent {
  type: string;
  corrId: string;
  ackCode?: string;
}

/**
 * The platform's transaction engine (the stateful ingestion-agent lifecycle and
 * the bulk transaction analyzer) is generic over the *shape* of a transaction.
 * A `TransactionProtocol` supplies the application-specific knowledge:
 *   - how to read a correlated message out of a raw log (`eventOf`),
 *   - which phases a transaction moves through, and
 *   - what counts as a successful ackCode.
 *
 * The initiating phase (`initial`, e.g. REQUEST) spawns an agent; the agent then
 * waits through `phases` in order (e.g. ['ACK','RESPONSE']) until it completes.
 * An app with a simpler shape declares `phases: ['RESPONSE']` (no ACK) — the
 * engine needs no change. The concrete protocol lives in the application package
 * (e.g. `@log/app-scp`), not in the platform.
 */
export interface TransactionProtocol {
  /** Stable id, e.g. 'scp'. */
  id: string;
  /** The initiating phase that spawns an agent (e.g. 'REQUEST'). */
  initial: string;
  /** Ordered phases after `initial` that an agent waits through, in order. */
  phases: string[];
  /** Full ordered phase list, `[initial, ...phases]` — used for progress rendering. */
  allPhases: string[];
  /** Extract a correlated event from a parsed log, or undefined if it is not a transaction message. */
  eventOf(log: ParsedLog): TxEvent | undefined;
  /** True when an ackCode denotes success. No/undefined ackCode is treated as success. */
  isSuccess(ackCode?: string): boolean;
}
