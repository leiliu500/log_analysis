import type { Agent } from './agentLifecycle.js';
import type { ParsedLog } from './logs.js';
import type { Severity } from './findings.js';
import type { QualityFinding, ValidationResult } from './validation.js';
import type { ReconciliationResult } from './application.js';

/**
 * The GENERIC backtest contract. This is the platform-side type only — the shared,
 * app-agnostic shape of a labelled validation case and a fixture-log factory. The
 * actual gold CASES and their app-specific log FIXTURES live in each application's
 * own package (`@log/app-scp`, `@log/app-apiflc`), exactly like each app's protocol,
 * prompts, cross-log-group join, and validation checks — never in shared. The
 * `@log/backtest` runner assembles them from the application registry and scores
 * them against the real validation engine.
 */

/**
 * The failure mode a gold case guards against — this is what makes the corpus a
 * HALLUCINATION / FALSE-POSITIVE / FALSE-NEGATIVE regression suite rather than a
 * generic pass/fail set. Every case is tagged with the defect it would catch so the
 * report proves coverage of each mode independently.
 *
 *  - clean          : a healthy transaction the engine must NOT flag
 *  - false-positive : looks suspicious but is correct; the engine must stay quiet
 *                     (a fabricated failure would be a false positive)
 *  - false-negative : genuinely broken; the engine MUST flag it (a silent pass = FN)
 *  - hallucination  : the agent recorded something its own logs contradict (a 500 as
 *                     `completed`, a fabricated phase); caught by re-deriving from
 *                     independent evidence
 */
export type FailureMode = 'clean' | 'false-positive' | 'false-negative' | 'hallucination';

export interface GoldCase {
  /** Unique, human-readable case name. */
  name: string;
  /** The failure mode this case guards against. */
  mode: FailureMode;
  /** Owning application id ('scp' | 'apiflc' | …). */
  app: string;
  /** The ingestion-agent record as persisted — i.e. what the agent CLAIMS happened. */
  agent: Pick<
    Agent,
    'messageId' | 'application' | 'status' | 'active' | 'waitingFor' | 'phases' | 'phaseTs' | 'spawnedAt' | 'closedAt'
  >;
  /** The raw parsed logs for this transaction — the INDEPENDENT ground truth. */
  logs: ParsedLog[];
  /** Severity of the `tx:<messageId>` lifecycle finding that exists in the store, if any. */
  findingSeverity?: Severity;
  /** Associated non-`tx:` quality findings (anomaly/correlation) on this transaction, if any. */
  qualityFindings?: QualityFinding[];
  /** Does the window cover the whole transaction lifetime? false ⇒ some logs rolled off. Default true. */
  windowComplete?: boolean;
  /** A synthetic system-of-record reconciliation result, to exercise the reconcile hook. */
  reconcile?: ReconciliationResult;
  /** `now` relative to which SLA / staleness is evaluated. */
  now: number;
  /** The human-confirmed correct validation result. */
  expected: ValidationResult;
  /** Optional: a delta the engine is expected to emit (check-level assertion). */
  expectDelta?: RegExp;
}

let _logSeq = 0;
/** Reset the fixture log-id counter — call at the top of a corpus module for stable ids. */
export function resetLogIds(): void {
  _logSeq = 0;
}

/**
 * A minimally-populated {@link ParsedLog} carrying `raw` (which every protocol parser
 * reads) at a timestamp — the generic fixture factory app corpora build on. Ids are
 * sequential and deterministic (no Date.now()/random) so a run is fully reproducible.
 */
export function makeParsedLog(stream: string, timestamp: number, raw: string, id?: string): ParsedLog {
  return {
    id: id ?? `bt-${String(++_logSeq).padStart(5, '0')}`,
    source: 'cloudwatch',
    stream,
    timestamp,
    level: 'info',
    message: raw,
    fields: {},
    entities: {},
    fingerprint: raw.slice(0, 40),
    raw,
    ingestedAt: timestamp,
  } as ParsedLog;
}
