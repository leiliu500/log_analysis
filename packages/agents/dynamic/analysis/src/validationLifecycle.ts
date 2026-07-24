import type {
  Agent,
  ApplicationDef,
  ApplicationRegistry,
  DerivedOutcome,
  Finding,
  ParsedLog,
  QualityFinding,
  ReconciliationResult,
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
 *   5. outcome re-derivation (status-vs-reality) — the terminal outcome is re-read
 *      DIRECTLY from the raw logs ({@link deriveOutcome}), independent of the status
 *      the agent recorded; a disagreement is a delta. This guards against an agent
 *      HALLUCINATING its outcome (a 500 recorded as completed, a real completion
 *      recorded as failed) — which checks 1–3, all keyed off the agent's own
 *      status/phaseTs, cannot see.
 *   6. evidence completeness — an agent that claims `completed` but whose logs prove
 *      the completing phase never arrived, or whose logs show a later phase without
 *      an earlier one, is a delta. Missing evidence never yields a confident success.
 *   7. system-of-record reconciliation (opt-in, ApplicationValidation.reconcile) —
 *      a cross-check against the downstream truth, the only signal that catches a
 *      false negative the logs themselves don't reveal.
 *   8. app-specific checks (opt-in, ApplicationValidation.checks) — invariants a
 *      protocol has that the generic engine can't express (e.g. SCP's REQUEST→ACK→
 *      RESPONSE ordering + duplicate-phase integrity; apiflc, with no ACK, has none).
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
  /**
   * Completed transactions that carried an associated analysis finding BELOW the
   * app's `qualityIssueSeverity` threshold — recorded but not surfaced as `issues`.
   * Counted so the by-design suppression is observable per app, never invisible.
   */
  suppressed: number;
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
  derived?: DerivedOutcome,
): ValidationAgent {
  const phaseTs = agent.phaseTs ?? {};
  const initialPhase = ctx.allPhases[0];
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

  // Still active — no finding is expected yet; validation is pending. But an agent
  // must not sit pending FOREVER: flag it as needs-attention when it is overdue.
  if (agent.active) {
    // The SLA clock (anchored on `fromPhase`) only runs once that phase arrives —
    // an agent stuck BEFORE its anchor (e.g. awaiting ACK) would never trip it. So
    // also flag staleness: no activity (last phase, else spawn) for longer than the
    // response budget. A heuristic to surface stuck agents, not a contractual SLA.
    const lastActivityTs = Math.max(agent.spawnedAt, ...Object.values(phaseTs));
    const stale = budgetMin != null && anchorTs == null && now - lastActivityTs > budgetMin * 60_000;
    const overdue = slaBreached
      ? `response overdue — no ${ctx.completingPhase ?? 'RESPONSE'} within ${budgetMin}m SLA`
      : stale
        ? `stuck — no activity for ${Math.round((now - lastActivityTs) / 60_000)}m (budget ${budgetMin}m)${agent.waitingFor ? `, still awaiting ${agent.waitingFor}` : ''}`
        : undefined;
    return {
      ...base,
      active: true,
      slaBreached: slaBreached || stale,
      result: 'pending',
      expectedFinding: false,
      actualFinding: false,
      delta: overdue ? [overdue] : [],
      missingPhases: [],
      qualityFindings: [],
      detail: overdue
        ? `NEEDS ATTENTION: ${overdue}`
        : agent.waitingFor
          ? `awaiting ${agent.waitingFor} — validation pending`
          : 'validation pending',
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

  // (5) Outcome re-derivation (status-vs-reality). The terminal outcome read
  // straight from the raw logs, independent of the status the agent recorded.
  // Only POSITIVE evidence speaks: an 'unknown' derivation (logs rolled off, or
  // insufficient) never produces a delta — the validator never invents a verdict
  // from missing logs. This is what catches an agent hallucinating its outcome.
  if (derived && derived.status !== 'unknown') {
    const d = derived.status;
    const via = derived.detail ? ` (${derived.detail})` : '';
    if (d === 'failed' && agent.status === 'completed') {
      // FALSE POSITIVE: a real failure the agent recorded as a clean completion.
      delta.push(`status mismatch: logs show a FAILED outcome${via}, agent recorded completed`);
    } else if (d === 'completed' && (agent.status === 'failed' || agent.status === 'error')) {
      // FALSE NEGATIVE: a real completion the agent recorded as failed/timed-out.
      delta.push(`status mismatch: logs show a completed outcome${via}, agent recorded ${agent.status}`);
    } else if (d === 'error' && agent.status === 'completed') {
      delta.push(`status mismatch: logs show no completing response${via}, agent recorded completed`);
    }
  }

  // (6) Evidence completeness. Only asserted when the window fully covers the
  // transaction's lifetime (`windowComplete`) — otherwise an absent phase may have
  // merely rolled off the loaded window, and we must not fault it.
  //  (a) The agent claims completed and we positively saw this transaction START in
  //      the window, yet its completing phase is absent from the logs — an
  //      unverifiable (likely fabricated) completion.
  if (
    derived?.windowComplete &&
    agent.status === 'completed' &&
    initialPhase != null &&
    ctx.completingPhase != null &&
    derived.phasesSeen.includes(initialPhase) &&
    !derived.phasesSeen.includes(ctx.completingPhase)
  ) {
    delta.push(`unverified completion: agent recorded completed but no ${ctx.completingPhase} found in logs`);
  }
  //  (b) A later phase is present in the logs while a strictly-earlier one is
  //      missing — a gap in the evidence chain (a lost log or out-of-order arrival).
  if (derived?.windowComplete && agent.status === 'completed' && derived.phasesSeen.length) {
    const order = ctx.allPhases;
    const lastIdx = Math.max(...derived.phasesSeen.map((p) => order.indexOf(p)));
    const gaps = order.slice(0, lastIdx).filter((p) => !derived.phasesSeen.includes(p));
    if (gaps.length) {
      delta.push(`incomplete evidence: ${order[lastIdx]} present in logs but earlier phase(s) ${gaps.join(', ')} missing`);
    }
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
export function appContextFor(agent: Pick<Agent, 'application'>, registry?: ApplicationRegistry): AppValidationContext {
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
 * The parsed_logs that belong to a transaction's whole call — resolved via the
 * application's own cross-log-group join (`relatedLogs`, e.g. apiflc bridges the
 * gateway requestId to the business correlationID), or, for an app without one,
 * every window log the protocol correlates to this transaction (scp's messageId).
 */
export function relatedLogsFor(app: ApplicationDef | undefined, messageId: string, windowLogs: ParsedLog[]): ParsedLog[] {
  if (!app) return [];
  if (app.relatedLogs) return app.relatedLogs(messageId, windowLogs);
  return windowLogs.filter((l) => app.protocol.eventOf(l)?.corrId === messageId);
}

/**
 * Re-derive a transaction's terminal outcome from its raw logs, independent of the
 * agent's recorded status — the app's own richer derivation when it supplies one
 * (apiflc reads the gateway HTTP status, which no protocol event carries), else a
 * generic protocol reading: a phase with a failure ackCode ⇒ failed, the completing
 * phase present ⇒ completed, else unknown. Returns `unknown` whenever the evidence
 * is insufficient — it never guesses, so absence alone can never fault an agent.
 */
export function deriveOutcome(
  app: ApplicationDef | undefined,
  messageId: string,
  relatedLogs: ParsedLog[],
  ctx: AppValidationContext,
): DerivedOutcome {
  if (app?.deriveOutcome) return app.deriveOutcome(messageId, relatedLogs);
  const proto = app?.protocol;
  if (!proto) return { status: 'unknown', evidenceLogIds: [], phasesSeen: [] };
  const evidence: string[] = [];
  const seen = new Set<string>();
  let failed = false;
  for (const l of relatedLogs) {
    const ev = proto.eventOf(l);
    if (!ev || ev.corrId !== messageId) continue;
    evidence.push(l.id);
    seen.add(ev.type);
    if (ev.ackCode && !proto.isSuccess(ev.ackCode)) failed = true;
  }
  const phasesSeen = ctx.allPhases.filter((p) => seen.has(p));
  if (!evidence.length) return { status: 'unknown', evidenceLogIds: [], phasesSeen: [] };
  if (failed) return { status: 'failed', evidenceLogIds: evidence, phasesSeen, detail: 'a phase carried a failure ackCode' };
  if (ctx.completingPhase && seen.has(ctx.completingPhase))
    return { status: 'completed', evidenceLogIds: evidence, phasesSeen, detail: `${ctx.completingPhase} present with a success code` };
  return { status: 'unknown', evidenceLogIds: evidence, phasesSeen, detail: `no ${ctx.completingPhase ?? 'completing'} phase in logs` };
}

/**
 * A system-of-record reconciliation reduced to a delta string, or null when the
 * record agrees or has nothing to say. Exported for unit testing. The agent's
 * terminal status collapses to completed vs failed (error = a failed outcome).
 */
export function reconcileDelta(agentStatus: string, recon: ReconciliationResult): string | null {
  if (recon.outcome === 'unknown') return null;
  const agentTerminal =
    agentStatus === 'completed' ? 'completed' : agentStatus === 'failed' || agentStatus === 'error' ? 'failed' : undefined;
  if (!agentTerminal || recon.outcome === agentTerminal) return null;
  return `system-of-record mismatch: record shows ${recon.outcome}, agent recorded ${agentStatus}${recon.detail ? ` (${recon.detail})` : ''}`;
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

  // One log-backed pass over recently-CLOSED transactions (bounded work): re-derive
  // each outcome straight from the raw logs, associate quality findings by shared
  // log identity, and sanity-check the join. Older closed agents keep whatever was
  // computed while they were recent.
  const qualitySince = now - qualityWindowMs;
  const recentClosed = history.filter((a) => (a.closedAt ?? 0) >= qualitySince);
  const qualityByMsg = new Map<string, QualityFinding[]>();
  const derivedByMsg = new Map<string, DerivedOutcome>();
  const relatedByMsg = new Map<string, ParsedLog[]>();
  if (recentClosed.length && registry) {
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
      // Join-sanity (#4): a physical log must belong to at most ONE transaction. A
      // logId claimed by two messageIds means the app's relatedLogs join over-linked.
      const owningMsgByLogId = new Map<string, string>();
      let joinConflicts = 0;
      for (const a of recentClosed) {
        const app = registry.byId(a.application);
        const ctx = appContextFor(a, registry);
        const related = relatedLogsFor(app, a.messageId, windowLogs);
        relatedByMsg.set(a.messageId, related);

        // (5) Re-derive the outcome from the logs. windowComplete = the window fully
        // covers this transaction's lifetime, so an absent phase is real, not rolled
        // off — the gate for the absence-based evidence checks.
        const derived = deriveOutcome(app, a.messageId, related, ctx);
        derived.windowComplete = a.spawnedAt >= qualitySince;
        derivedByMsg.set(a.messageId, derived);

        for (const l of related) {
          const prev = owningMsgByLogId.get(l.id);
          if (prev && prev !== a.messageId) joinConflicts += 1;
          else owningMsgByLogId.set(l.id, a.messageId);
        }

        // (4) Associate quality findings — only meaningful for a completed transaction.
        if (a.status === 'completed') {
          const seen = new Set<string>();
          const qfs: QualityFinding[] = [];
          for (const l of related) {
            for (const f of byLogId.get(l.id) ?? []) {
              if (f.application && a.application && f.application !== a.application) continue;
              if (seen.has(f.id)) continue;
              seen.add(f.id);
              qfs.push({ id: f.id, severity: f.severity, kind: f.kind, title: f.title });
            }
          }
          if (qfs.length) qualityByMsg.set(a.messageId, qfs);
        }
      }
      if (joinConflicts > 0) {
        console.error(
          `validation: relatedLogs join attributed ${joinConflicts} log line(s) to more than one transaction — possible over-linking`,
        );
      }
    } catch (err) {
      console.error('validation: log-backed derivation/association skipped', (err as Error).message);
    }
  }

  const validations: ValidationAgent[] = [];
  for (const a of active) validations.push(validateAgent(a, undefined, now, appContextFor(a, registry)));
  for (const a of history) {
    validations.push(
      validateAgent(
        a,
        severities.get(a.messageId),
        now,
        appContextFor(a, registry),
        qualityByMsg.get(a.messageId) ?? [],
        derivedByMsg.get(a.messageId),
      ),
    );
  }

  // App-specific extra checks + system-of-record reconciliation — opt-in per app,
  // recent closed only. Both append deltas that force a failure (a lifecycle/
  // structural discrepancy always takes precedence over a clean/issues result).
  if (registry) {
    const byMsg = new Map(validations.map((v) => [v.messageId, v]));
    const addFailure = (v: ValidationAgent, msg: string): void => {
      v.delta = [...v.delta, msg];
      v.result = 'failure';
      v.detail = v.delta.join('; ');
    };
    for (const a of recentClosed) {
      const app = registry.byId(a.application);
      const v = byMsg.get(a.messageId);
      if (!v) continue;
      const related = relatedByMsg.get(a.messageId) ?? [];

      // (8) App-specific rules the generic engine cannot express (e.g. SCP's
      // REQUEST→ACK→RESPONSE ordering + duplicate-phase integrity). apiflc declares none.
      const checks = app?.validation?.checks;
      if (checks) {
        try {
          for (const d of checks({ messageId: a.messageId, agentStatus: a.status, relatedLogs: related })) addFailure(v, d);
        } catch (err) {
          console.error(`validation: app checks failed for ${a.messageId}`, (err as Error).message);
        }
      }

      // (7) System-of-record reconciliation — the only check that can catch a false
      // negative the shared log evidence cannot show.
      const recon = app?.validation?.reconcile;
      if (recon) {
        try {
          const result = await recon({ messageId: a.messageId, agentStatus: a.status, relatedLogs: related });
          const msg = reconcileDelta(a.status, result);
          if (msg) addFailure(v, msg);
        } catch (err) {
          console.error(`validation: reconcile failed for ${a.messageId}`, (err as Error).message);
        }
      }
    }
  }

  await upsertValidationAgents(validations);
  await pruneClosedValidationAgentsOlderThan(now - historyTtlMs);

  const empty = (): ValidationCounts => ({ checked: 0, passed: 0, issues: 0, failed: 0, pending: 0, suppressed: 0 });
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
    // (5-surfacing) A clean success that still carried an associated finding means
    // the finding was below the app's threshold and suppressed — count it so the
    // by-design suppression is observable per app rather than silently invisible.
    if (v.result === 'success' && v.qualityFindings.length > 0) bump('suppressed');
  }

  return { ...total, byApplication };
}
