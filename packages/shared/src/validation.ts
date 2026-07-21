import type { Agent } from './agentLifecycle.js';
import type { Severity } from './findings.js';

/**
 * A validation agent — an autonomous shadow of a regular ingestion {@link Agent},
 * keyed by the same `messageId`. It independently proves the lifecycle's core
 * invariant per transaction, with no human interaction: every NON-completed
 * closed agent must have exactly one finding `tx:<messageId>` at the severity its
 * close reason implies, and a completed agent must have none. It runs in a
 * separate poller from the ingestion path — it only READS `agents` + `findings`
 * and WRITES `validation_agents`, so it can never mutate or block regular ingest.
 *
 *   pending  → the regular agent is still active (awaiting); no expectation yet   (active)
 *   success  → the regular agent closed and findings match (presence + level)     (inactive)
 *   failure  → a delta was found (missing / unexpected / wrong-level finding)      (inactive)
 */
export type ValidationResult = 'pending' | 'success' | 'failure';

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
  /** Whether the invariant requires a finding for this agent. */
  expectedFinding: boolean;
  /** The severity level the finding is expected to carry (when expected). */
  expectedSeverity?: Severity;
  /** Whether a `tx:<messageId>` finding actually exists. */
  actualFinding: boolean;
  /** The severity level the actual finding carries. */
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
  /** The protocol's ordered phases (copied from the agent), for progress rendering. */
  phases: string[];
  /** Phase name → timestamp (copied from the agent). */
  phaseTs: Record<string, number>;
  /** Human note on the validation outcome. */
  detail?: string;
  spawnedAt: number;
  updatedAt: number;
  closedAt?: number;
}

/**
 * The invariant, encoded once (mirrors `agentFinding` in the analysis package):
 *   failed    ⇒ a finding at 'high'
 *   error     ⇒ a finding at 'medium' (timeout)
 *   completed ⇒ no finding
 *   awaiting  ⇒ no expectation yet (still active)
 */
export function expectedFindingFor(agent: Pick<Agent, 'status'>): {
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
