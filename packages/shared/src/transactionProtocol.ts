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
  /**
   * Does this record BEGIN a protocol message, rather than continue the one above it?
   *
   * CloudWatch stores one event per physical line, so a multi-line message arrives as
   * several records and no single one carries every field {@link eventOf} needs. The
   * engine therefore coalesces records into entries before extracting events — but the
   * generic continuation heuristic recognises AWS Lambda / API-Gateway line starts only.
   * A format it does not know (SCP's `<ns2:cashMessage>` XML) looks like a continuation
   * throughout, so two consecutive messages in one stream would silently merge into one
   * entry and the second would vanish.
   *
   * Declaring this makes each message start its own entry. It may only FORCE a start,
   * never force a continuation, so an over-eager implementation costs nothing worse than
   * the un-coalesced behaviour. Apps whose logs are plain AWS format (apiflc) can omit it.
   */
  startsEntry?(log: ParsedLog): boolean;
}
