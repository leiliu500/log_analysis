import type {
  Agent,
  ApplicationDef,
  ApplicationRegistry,
  Finding,
  ParsedLog,
  QualityFinding,
  Severity,
  ValidationAgent,
} from '@log/shared';
import { expectedFindingFor } from '@log/shared';
import {
  getActiveAgents,
  getAgentHistory,
  getAgentFindingSeverities,
  getNonTransactionFindingsSince,
  queryLogs,
  upsertValidationAgents,
  pruneClosedValidationAgentsOlderThan,
} from '@log/db';

/**
 * The autonomous validation lifecycle — a 1:1 shadow of the ingestion agents that
 * independently proves, per application and with no human interaction, that each
 * regular agent's transaction is consistent. Per the application's own
 * `validation.md` spec it checks:
 *   1. the finding/level invariant — a NON-completed closed agent must have one
 *      finding `tx:<messageId>` at the implied level (failed⇒high, timeout⇒medium),
 *      a completed agent none;
 *   2. phase completeness — a completed transaction received every protocol phase;
 *   3. the app response SLA — the completing RESPONSE within the app's budget;
 *   4. associated quality findings — a COMPLETED transaction can still have
 *      analysis findings (anomaly/correlation, e.g. a high-latency anomaly on a 200
 *      response). Those are linked to the transaction by shared log identity and
 *      surfaced: a high/critical one yields `completed_with_issues` (distinct from a
 *      lifecycle failure); otherwise the transaction is a clean `success`.
 *
 * It is isolated from the ingest path: it only READS `agents` / `findings` /
 * `parsed_logs` and WRITES `validation_agents`, so it can never mutate or block
 * regular ingestion. Like `getUnreportedClosedAgents`, it is self-healing.
 */

export interface ValidationCounts {
  checked: number;
  passed: number;
  /** Completed transactions with a high/critical associated analysis finding. */
  issues: number;
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
  /**
   * Minimum associated-finding severity that makes a completed transaction
   * 'completed_with_issues' (the app owns this knob; defaults to 'high').
   */
  qualityIssueSeverity?: Severity;
}

/** Severity ordering — used to pick the worst associated finding and to gate 'issues'. */
const SEVERITY_RANK: Record<string, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const rank = (s?: string): number => (s ? SEVERITY_RANK[s] ?? 0 : 0);
const worstSeverity = (fs: QualityFinding[]): Severity | undefined =>
  fs.length ? (fs.reduce((a, b) => (rank(b.severity) > rank(a.severity) ? b : a)).severity as Severity) : undefined;
/** Does `sev` meet the app's "issues" threshold (default 'high')? */
const meetsThreshold = (sev: Severity | undefined, threshold: Severity = 'high'): boolean =>
  sev != null && rank(sev) >= rank(threshold);

/** Compare one regular agent against the findings + its app rules → a validation agent. */
export function validateAgent(
  agent: Pick<
    Agent,
    'messageId' | 'application' | 'status' | 'active' | 'waitingFor' | 'phases' | 'phaseTs' | 'spawnedAt' | 'closedAt'
  >,
  findingSeverity: string | undefined,
  now: number,
  ctx: AppValidationContext = { allPhases: [] },
  qualityFindings: QualityFinding[] = [],
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

  // Still active — no finding is expected yet; validation is pending.
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
      qualityFindings: [],
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

  // (2) Phase completeness — only a COMPLETED transaction must have every phase.
  const missingPhases =
    agent.status === 'completed' ? ctx.allPhases.filter((p) => phaseTs[p] === undefined) : [];
  if (missingPhases.length) delta.push(`missing phase(s): ${missingPhases.join(', ')}`);

  // (3) Response SLA — a completed transaction whose RESPONSE arrived after budget.
  if (agent.status === 'completed' && slaBreached && budgetMin != null) {
    const late = responseLatencyMs != null ? Math.round(responseLatencyMs / 60_000) : undefined;
    delta.push(
      `SLA breach: ${ctx.completingPhase ?? 'RESPONSE'} took ${late ?? '?'}m after ${fromPhase} (budget ${budgetMin}m)`,
    );
  }

  // (4) Associated quality findings — only meaningful for a completed transaction.
  const quality = agent.status === 'completed' ? qualityFindings : [];
  const maxQualitySeverity = worstSeverity(quality);

  // Result: a lifecycle delta is a hard failure and takes precedence. Otherwise a
  // completed transaction with a high/critical associated finding is surfaced as
  // 'completed_with_issues' (NOT a failure — the agent behaved correctly). A clean
  // completion, or one with only info/low findings, is a success.
  let result: ValidationAgent['result'];
  let detail: string;
  if (delta.length > 0) {
    result = 'failure';
    detail = delta.join('; ');
  } else if (agent.status === 'completed' && meetsThreshold(maxQualitySeverity, ctx.qualityIssueSeverity)) {
    result = 'completed_with_issues';
    detail = `completed, but ${quality.length} associated finding(s) — highest ${maxQualitySeverity}`;
  } else {
    result = 'success';
    detail = expected
      ? `finding present at ${expectedSeverity}`
      : quality.length
        ? `completed cleanly; ${quality.length} low/info finding(s)`
        : 'phases complete within SLA; no finding expected';
  }

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
    qualityFindings: quality,
    maxQualitySeverity,
    detail,
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
    qualityIssueSeverity: app?.validation?.qualityIssueSeverity,
  };
}

/**
 * The set of parsed_logs ids that belong to a transaction's whole call — resolved
 * via the application's own cross-log-group join (`relatedLogs`, e.g. apiflc bridges
 * the gateway requestId to the business correlationID), or, for an app without one,
 * every window log the protocol correlates to this transaction (scp's messageId).
 */
function relatedLogIds(app: ApplicationDef | undefined, messageId: string, windowLogs: ParsedLog[]): Set<string> {
  if (!app) return new Set();
  if (app.relatedLogs) return new Set(app.relatedLogs(messageId, windowLogs).map((l) => l.id));
  return new Set(windowLogs.filter((l) => app.protocol.eventOf(l)?.corrId === messageId).map((l) => l.id));
}

/**
 * DB-backed driver — the complete per-poll validation step. Loads all regular
 * agents, the agent-lifecycle finding severities, and (for recently-completed
 * transactions) the window's parsed logs + analysis findings so it can associate
 * quality findings by shared log identity. Evaluates each agent against its
 * application's rules and upserts the shadow validation agents. Best-effort
 * throughout; nothing here can affect the ingest path.
 */
export async function validateAgents(
  registry?: ApplicationRegistry,
  opts: { now?: number; historyTtlMs?: number; qualityWindowMs?: number } = {},
): Promise<ValidationRunResult> {
  const now = opts.now ?? Date.now();
  const historyTtlMin = Number(process.env.INGEST_AGENT_HISTORY_TTL_MINUTES ?? 1440);
  const historyTtlMs = opts.historyTtlMs ?? historyTtlMin * 60_000;
  // How far back to associate quality findings. Bounds the parsed_logs read; older
  // completed transactions keep the association computed while they were recent.
  const qualityWindowMs =
    opts.qualityWindowMs ?? Number(process.env.VALIDATION_QUALITY_WINDOW_MINUTES ?? 60) * 60_000;

  const [active, history] = await Promise.all([getActiveAgents(2000), getAgentHistory(2000)]);
  const closedIds = history.map((a) => a.messageId);
  const severities = await getAgentFindingSeverities(closedIds);

  // Associate analysis (non-tx) findings with recently-completed transactions by
  // shared log identity. Only recent completions are (re)matched — bounded work.
  const qualitySince = now - qualityWindowMs;
  const completedRecent = history.filter(
    (a) => a.status === 'completed' && (a.closedAt ?? 0) >= qualitySince,
  );
  const qualityByMsg = new Map<string, QualityFinding[]>();
  if (completedRecent.length && registry) {
    try {
      const [windowLogs, analysisFindings] = await Promise.all([
        queryLogs({ from: qualitySince, limit: 20_000 }),
        getNonTransactionFindingsSince(qualitySince, 2000),
      ]);
      // Index findings by each evidence logId (app-scoped so ids never cross apps).
      const byLogId = new Map<string, Finding[]>();
      for (const f of analysisFindings) {
        for (const e of f.evidence ?? []) {
          const arr = byLogId.get(e.logId) ?? [];
          arr.push(f);
          byLogId.set(e.logId, arr);
        }
      }
      for (const a of completedRecent) {
        const app = registry.byId(a.application);
        const ids = relatedLogIds(app, a.messageId, windowLogs);
        if (!ids.size) continue;
        const seen = new Set<string>();
        const qfs: QualityFinding[] = [];
        for (const id of ids) {
          for (const f of byLogId.get(id) ?? []) {
            if (f.application && a.application && f.application !== a.application) continue;
            if (seen.has(f.id)) continue;
            seen.add(f.id);
            qfs.push({ id: f.id, severity: f.severity, kind: f.kind, title: f.title });
          }
        }
        if (qfs.length) qualityByMsg.set(a.messageId, qfs);
      }
    } catch (err) {
      console.error('validation: quality-finding association skipped', (err as Error).message);
    }
  }

  const validations: ValidationAgent[] = [];
  for (const a of active) validations.push(validateAgent(a, undefined, now, appContextFor(a, registry)));
  for (const a of history) {
    validations.push(
      validateAgent(a, severities.get(a.messageId), now, appContextFor(a, registry), qualityByMsg.get(a.messageId) ?? []),
    );
  }

  await upsertValidationAgents(validations);
  await pruneClosedValidationAgentsOlderThan(now - historyTtlMs);

  const empty = (): ValidationCounts => ({ checked: 0, passed: 0, issues: 0, failed: 0, pending: 0 });
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
    else if (v.result === 'completed_with_issues') bump('issues');
    else if (v.result === 'failure') bump('failed');
    else bump('pending');
  }

  return { ...total, byApplication };
}
