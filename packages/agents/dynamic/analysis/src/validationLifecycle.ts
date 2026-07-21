import type { Agent, ApplicationRegistry, ValidationAgent } from '@log/shared';
import { expectedFindingFor } from '@log/shared';
import {
  getActiveAgents,
  getAgentHistory,
  getAgentFindingSeverities,
  upsertValidationAgents,
  pruneClosedValidationAgentsOlderThan,
} from '@log/db';

/**
 * The autonomous validation lifecycle — a 1:1 shadow of the ingestion agents that
 * independently proves, per application and with no human interaction, that each
 * regular agent's transaction is consistent. Per the application's own
 * `validation.md` spec (surfaced via {@link ApplicationValidation}) it checks:
 *   1. the finding/level invariant — a NON-completed closed agent must have one
 *      finding `tx:<messageId>` at the implied level (failed⇒high, timeout⇒medium),
 *      a completed agent none (see `expectedFindingFor` + `agentFinding`);
 *   2. phase completeness — a completed transaction must have received every
 *      protocol phase (SCP: REQUEST→ACK→RESPONSE; apiflc: REQUEST→RESPONSE);
 *   3. the app response SLA — the completing RESPONSE within the app's budget,
 *      measured from its anchor phase (SCP: 30 min after ACK; apiflc: 2 min after
 *      REQUEST).
 *
 * It is deliberately isolated from the ingest path: it only READS `agents` +
 * `findings` and WRITES `validation_agents`, sharing no code path, transaction, or
 * table write with `advanceAgents` / `dispatchAgentic`. It runs in its own poller
 * (separate Lambda + schedule), so a validation failure or crash can never mutate
 * or block regular ingestion. Like `getUnreportedClosedAgents`, it is self-healing:
 * it re-derives every validation agent from the currently-persisted agents +
 * findings each run, so a transient delta is corrected on the next pass.
 */

export interface ValidationCounts {
  checked: number;
  passed: number;
  failed: number;
  pending: number;
}

export interface ValidationRunResult extends ValidationCounts {
  /** Per-application breakdown (application id → counts). */
  byApplication: Record<string, ValidationCounts>;
}

/** The per-application validation context resolved from the registry for one agent. */
export interface AppValidationContext {
  /** Full ordered phase list the protocol defines (initial + phases). */
  allPhases: string[];
  /** The phase whose arrival completes the transaction (protocol's last phase). */
  completingPhase?: string;
  /** Minutes allowed to receive the completing RESPONSE, from the anchor phase. */
  responseTimeoutMinutes?: number;
  /** The phase the SLA clock starts from (scp: 'ACK', apiflc: 'REQUEST'). */
  responseTimeoutFrom?: string;
}

/** Compare one regular agent against the findings + its app rules → a validation agent. */
export function validateAgent(
  agent: Pick<
    Agent,
    'messageId' | 'application' | 'status' | 'active' | 'waitingFor' | 'phases' | 'phaseTs' | 'spawnedAt' | 'closedAt'
  >,
  findingSeverity: string | undefined,
  now: number,
  ctx: AppValidationContext = { allPhases: [] },
): ValidationAgent {
  const phaseTs = agent.phaseTs ?? {};
  const budgetMin = ctx.responseTimeoutMinutes;
  const fromPhase = ctx.responseTimeoutFrom;
  const anchorTs = fromPhase ? phaseTs[fromPhase] : undefined;
  const completingTs = ctx.completingPhase ? phaseTs[ctx.completingPhase] : undefined;

  // SLA: latency from the anchor phase to the RESPONSE (or, while overdue, to now).
  let slaBreached = false;
  let responseLatencyMs: number | undefined;
  if (budgetMin != null && anchorTs != null) {
    const budgetMs = budgetMin * 60_000;
    if (completingTs != null) {
      responseLatencyMs = completingTs - anchorTs;
      slaBreached = responseLatencyMs > budgetMs;
    } else if (agent.active) {
      // No completing phase yet — overdue once we're past the budget.
      responseLatencyMs = now - anchorTs;
      slaBreached = responseLatencyMs > budgetMs;
    }
  }

  const base = {
    messageId: agent.messageId,
    application: agent.application,
    agentStatus: agent.status,
    slaBudgetMinutes: budgetMin,
    slaFromPhase: fromPhase,
    responseLatencyMs,
    slaBreached,
    phases: agent.phases ?? ctx.allPhases,
    phaseTs,
    spawnedAt: agent.spawnedAt,
    updatedAt: now,
  };

  // Still active — no finding is expected yet; validation is pending. An active
  // transaction that has blown its SLA is surfaced (slaBreached) but stays pending
  // so it remains an active card until its regular agent closes.
  if (agent.active) {
    const overdue = slaBreached
      ? `response overdue — no ${ctx.completingPhase ?? 'RESPONSE'} within ${budgetMin}m SLA`
      : undefined;
    return {
      ...base,
      active: true,
      result: 'pending',
      expectedFinding: false,
      actualFinding: false,
      delta: overdue ? [overdue] : [],
      missingPhases: [],
      detail: overdue ?? (agent.waitingFor ? `awaiting ${agent.waitingFor} — validation pending` : 'validation pending'),
    };
  }

  const { expected, severity: expectedSeverity } = expectedFindingFor(agent);
  const actualFinding = findingSeverity !== undefined;
  const actualSeverity = findingSeverity;
  const delta: string[] = [];

  // (1) Finding / level invariant.
  if (expected && !actualFinding) {
    delta.push(`missing finding: expected a ${expectedSeverity} finding for ${agent.status} agent, none found`);
  } else if (!expected && actualFinding) {
    delta.push(`unexpected finding: ${agent.status} agent should have no finding, found one (${actualSeverity})`);
  } else if (expected && actualFinding && actualSeverity !== expectedSeverity) {
    delta.push(`wrong level: expected ${expectedSeverity}, found ${actualSeverity}`);
  }

  // (2) Phase completeness — only a COMPLETED transaction is required to have every
  // phase; a failed/timed-out agent is expected to be missing phases (that is why
  // it closed abnormally), so we don't fault it for that.
  const missingPhases =
    agent.status === 'completed' ? ctx.allPhases.filter((p) => phaseTs[p] === undefined) : [];
  if (missingPhases.length) {
    delta.push(`missing phase(s): ${missingPhases.join(', ')}`);
  }

  // (3) Response SLA — a completed transaction whose RESPONSE arrived after budget.
  if (agent.status === 'completed' && slaBreached && budgetMin != null) {
    const late = responseLatencyMs != null ? Math.round(responseLatencyMs / 60_000) : undefined;
    delta.push(
      `SLA breach: ${ctx.completingPhase ?? 'RESPONSE'} took ${late ?? '?'}m after ${fromPhase} (budget ${budgetMin}m)`,
    );
  }

  const result: ValidationAgent['result'] = delta.length === 0 ? 'success' : 'failure';
  const detail =
    result === 'success'
      ? expected
        ? `finding present at ${expectedSeverity}; phases complete within SLA`
        : 'phases complete within SLA; no finding expected'
      : delta.join('; ');

  return {
    ...base,
    active: false,
    result,
    expectedFinding: expected,
    expectedSeverity,
    actualFinding,
    actualSeverity,
    delta,
    missingPhases,
    detail,
    // Mirror the regular agent's close time so validation history sorts/prunes in
    // lockstep with agent history.
    closedAt: agent.closedAt ?? now,
  };
}

/** Resolve one application's validation context from the registry (phases + SLA). */
function appContextFor(agent: Pick<Agent, 'application'>, registry?: ApplicationRegistry): AppValidationContext {
  const app = registry?.byId(agent.application);
  const proto = app?.protocol;
  const allPhases = proto?.allPhases ?? [];
  const completingPhase = proto?.phases.length ? proto.phases[proto.phases.length - 1] : undefined;
  return {
    allPhases,
    completingPhase,
    responseTimeoutMinutes: app?.validation?.responseTimeoutMinutes,
    responseTimeoutFrom: app?.validation?.responseTimeoutFrom,
  };
}

/**
 * DB-backed driver — the complete per-poll validation step. Loads all regular
 * agents (active + closed within retention), reads the agent-lifecycle finding
 * severities in one query, evaluates each against its application's validation
 * rules, and upserts the shadow validation agents. Every step is best-effort;
 * nothing here can affect the ingest path.
 */
export async function validateAgents(
  registry?: ApplicationRegistry,
  opts: { now?: number; historyTtlMs?: number } = {},
): Promise<ValidationRunResult> {
  const now = opts.now ?? Date.now();
  const historyTtlMin = Number(process.env.INGEST_AGENT_HISTORY_TTL_MINUTES ?? 1440);
  const historyTtlMs = opts.historyTtlMs ?? historyTtlMin * 60_000;

  const [active, history] = await Promise.all([getActiveAgents(2000), getAgentHistory(2000)]);
  const closedIds = history.map((a) => a.messageId);
  const severities = await getAgentFindingSeverities(closedIds);

  const validations: ValidationAgent[] = [];
  for (const a of active) validations.push(validateAgent(a, undefined, now, appContextFor(a, registry)));
  for (const a of history) {
    validations.push(validateAgent(a, severities.get(a.messageId), now, appContextFor(a, registry)));
  }

  await upsertValidationAgents(validations);
  await pruneClosedValidationAgentsOlderThan(now - historyTtlMs);

  const empty = (): ValidationCounts => ({ checked: 0, passed: 0, failed: 0, pending: 0 });
  const byApplication: Record<string, ValidationCounts> = {};
  const total = empty();
  for (const v of validations) {
    const b = (byApplication[v.application ?? 'unknown'] ??= empty());
    b.checked += 1;
    total.checked += 1;
    const bump = (k: keyof ValidationCounts) => {
      b[k] += 1;
      total[k] += 1;
    };
    if (v.result === 'success') bump('passed');
    else if (v.result === 'failure') bump('failed');
    else bump('pending');
  }

  return { ...total, byApplication };
}
