import type { Agent } from './agentLifecycle.js';
import type { Severity } from './anomalies.js';
import type { AiValidationFinding } from './validationAgent.js';

/**
 * A validation agent — an autonomous shadow of a regular ingestion {@link Agent},
 * keyed by the same `messageId`. It independently proves the lifecycle's core
 * invariant per transaction, with no human interaction: every NON-completed
 * closed agent must have exactly one anomaly `tx:<messageId>` at the severity its
 * close reason implies, and a completed agent must have none. It runs in a
 * separate poller from the ingestion path — it only READS `agents` + `anomalies`
 * and WRITES `validation_agents`, so it can never mutate or block regular ingest.
 *
 *   pending                → the regular agent is still active (awaiting); no expectation yet (active)
 *   success                → closed, the invariant holds and (if completed) no high/critical
 *                            associated analysis anomaly                                     (inactive)
 *   completed_with_issues  → completed correctly (no lifecycle failure), BUT the transaction
 *                            has ≥1 high/critical associated analysis anomaly (e.g. a high-
 *                            latency anomaly on a 200 response) — surfaced, not a failure     (inactive)
 *   failure                → a lifecycle delta was found (missing / unexpected / wrong-level
 *                            anomaly, missing phase, or SLA breach)                           (inactive)
 *   ai_suspected           → the DETERMINISTIC engine found no delta but could not PROVE the
 *                            outcome from the logs (the residual), and the app's validation AI
 *                            agent raised a claim that re-verified against the real log rows.
 *                            A distinct, non-authoritative population: it is never produced by
 *                            the deterministic checks and never overrides one of their verdicts
 *                            — see {@link ValidationAgent.aiFindings}                (inactive)
 */
export type ValidationResult = 'pending' | 'success' | 'completed_with_issues' | 'failure' | 'ai_suspected';

/**
 * An analysis anomaly (anomaly/correlation/…, NOT a `tx:` lifecycle anomaly) that
 * belongs to a completed transaction — associated by shared log identity (the
 * anomaly's evidence logs are part of the transaction's call). Surfaced on the
 * validation agent so a clean completion is distinguished from one with quality
 * issues (high latency, etc.) instead of the anomaly being silently ignored.
 */
export interface QualityAnomaly {
  id: string;
  severity: Severity;
  kind: string;
  title: string;
}

export interface ValidationAgent {
  /** Correlation id — mirrors the regular agent's messageId. */
  messageId: string;
  /** Owning application id (e.g. 'scp', 'apiflc'). */
  application?: string;
  /** The mirrored regular-agent status at validation time. */
  agentStatus: Agent['status'];
  /** True while the regular agent is active (validation pending). */
  active: boolean;
  result: ValidationResult;
  /** Whether the invariant requires a anomaly for this agent. */
  expectedAnomaly: boolean;
  /** The severity level the anomaly is expected to carry (when expected). */
  expectedSeverity?: Severity;
  /** Whether a `tx:<messageId>` anomaly actually exists. */
  actualAnomaly: boolean;
  /** The severity level the actual anomaly carries. */
  actualSeverity?: string;
  /** Human-readable mismatches; empty on success. */
  delta: string[];
  /**
   * Protocol phases the transaction never received. Empty when every phase is
   * accounted for. Only meaningful for a completed agent (a failed/timed-out
   * agent is expected to be missing phases).
   */
  missingPhases: string[];
  /**
   * True when the completing RESPONSE breached this app's SLA — arrived later than
   * the budget (completed), or is still overdue with no RESPONSE (active).
   */
  slaBreached: boolean;
  /** This app's response-timeout budget in minutes (from its validation config). */
  slaBudgetMinutes?: number;
  /** The phase the SLA clock starts from (scp: 'ACK', apiflc: 'REQUEST'). */
  slaFromPhase?: string;
  /** Measured latency from the SLA anchor phase to the RESPONSE (or to now, if overdue). */
  responseLatencyMs?: number;
  /**
   * Analysis anomalies (anomaly/correlation/…) associated with this completed
   * transaction by shared log identity. Empty for a clean completion. A high/critical
   * one drives the `completed_with_issues` result.
   */
  qualityAnomalies: QualityAnomaly[];
  /** The highest severity among {@link qualityAnomalies}, if any. */
  maxQualitySeverity?: Severity;
  /** The protocol's ordered phases (copied from the agent), for progress rendering. */
  phases: string[];
  /** Phase name → timestamp (copied from the agent). */
  phaseTs: Record<string, number>;
  /**
   * Claims the app's validation AI agent raised for this transaction that SURVIVED
   * deterministic re-verification (every cited logId real, every predicate re-executed
   * true — see {@link admitClaim}). Only ever populated for a residual transaction: one
   * the deterministic engine passed without being able to prove the outcome from its
   * logs. These are suspicions, not verdicts — they never change `delta`, and they never
   * turn a deterministic `failure` or `completed_with_issues` into anything else.
   */
  aiFindings: AiValidationFinding[];
  /**
   * How many of the agent's claims the admission gate DISCARDED this review (fabricated
   * log id, predicate that did not hold, no witness). Persisted so the model's
   * hallucination rate is an observable production number rather than an assumption.
   */
  aiRejected?: number;
  /**
   * Why the AI review could not be completed (model error, throttling, a reply too
   * mangled to recover). When set with no findings, {@link aiReviewedAt} stays UNSET —
   * a failed review must never read as "reviewed and clean", and the next poll retries it.
   */
  aiError?: string;
  /** When the AI review ran (absent ⇒ this transaction was never residual, or it failed). */
  aiReviewedAt?: number;
  /** Human note on the validation outcome. */
  detail?: string;
  spawnedAt: number;
  updatedAt: number;
  closedAt?: number;
}

/**
 * One application's VALIDATION AI AGENT as a given runtime has it configured — the
 * registry declaration plus the env that gates it. Lives here (like `BacktestSummary`)
 * so the API and the web UI share one contract without the UI depending on the engine.
 *
 * It reports the EFFECTIVE configuration of the process that served it, not a static
 * description: the API container and the validation Lambda are configured separately and
 * have drifted before, so an agent must never render as healthy in a runtime that
 * actually has it switched off.
 */
export interface ValidationAgentInfo {
  application: string;
  displayName: string;
  /** True only if the app declares an agent AND the stage is switched on here. */
  enabled: boolean;
  /** Why it is off, when it is — so a disabled agent is never silently invisible. */
  disabledReason?: string;
  /** The app's own validation-agent spec (its prompt). */
  promptPath?: string;
  /** 'clean' = every deterministically-clean transaction; 'unproven' = only unprovable outcomes. */
  scope: 'clean' | 'unproven';
  maxPerPoll: number;
  deadlineMs: number;
  /** Reviews recorded before this instant are stale and get redone. */
  reviewEpoch: number;
}

/**
 * The invariant, encoded once (mirrors `agentAnomaly` in the analysis package):
 *   failed    ⇒ a anomaly at 'high'
 *   error     ⇒ a anomaly at 'medium' (timeout)
 *   completed ⇒ no anomaly
 *   awaiting  ⇒ no expectation yet (still active)
 */
export function expectedAnomalyFor(agent: Pick<Agent, 'status'>): {
  expected: boolean;
  severity?: Severity;
} {
  switch (agent.status) {
    case 'failed':
      return { expected: true, severity: 'high' };
    case 'error':
      return { expected: true, severity: 'medium' };
    case 'completed':
      return { expected: false };
    default: // 'awaiting' — active, not yet evaluated
      return { expected: false };
  }
}
