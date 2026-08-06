import type {
  Agent,
  AiReviewOutcome,
  ApplicationDef,
  ApplicationRegistry,
  DerivedOutcome,
  Anomaly,
  ParsedLog,
  QualityAnomaly,
  ReconciliationResult,
  Severity,
  ValidationAgent,
  ValidationAgentInfo,
  ValidationClaim,
  ValidationReasoner,
} from '@log/shared';
import { expectedAnomalyFor } from '@log/shared';
import { converse } from './bedrock.js';
import {
  getActiveAgents,
  getAgentHistory,
  getAgentAnomalySeverities,
  getAiReviewedMessageIds,
  getNonTransactionAnomaliesSince,
  startValidationAgentRuns,
  finishValidationAgentRun,
  reapValidationAgentRuns,
  queryLogs,
  upsertValidationAgents,
  pruneClosedValidationAgentsOlderThan,
} from '@log/db';

/**
 * The autonomous validation lifecycle — a 1:1 shadow of the ingestion agents that
 * independently proves, per application and with no human interaction, that each
 * regular agent's transaction is consistent. Per the application's own
 * `validation.md` spec it checks:
 *   1. the anomaly/level invariant — a NON-completed closed agent must have one
 *      anomaly `tx:<messageId>` at the implied level (failed⇒high, timeout⇒medium),
 *      a completed agent none;
 *   2. phase completeness — a completed transaction received every protocol phase;
 *   3. the app response SLA — the completing RESPONSE within the app's budget;
 *   4. associated quality anomalies — a COMPLETED transaction can still have
 *      analysis anomalies (anomaly/correlation, e.g. a high-latency anomaly on a 200
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
 *   9. the app's VALIDATION AI AGENT (opt-in, ApplicationValidation.validationAgent) —
 *      the ONLY model in this path, and deliberately powerless. It runs on the RESIDUAL
 *      only ({@link residualReason}): transactions checks 1–8 passed while check 5 could
 *      not PROVE the outcome from the logs — the set that today passes without evidence.
 *      Its claims must cite real `parsed_logs` ids and carry predicates that the platform
 *      re-executes before admitting them, so a fabricated id or quote is dropped rather
 *      than recorded. Admitted claims land in `aiFindings` and the separate
 *      `ai_suspected` result; they NEVER append a delta and never overturn checks 1–8.
 *      Consequence: the model can only reduce false negatives on the unproven set, and
 *      is structurally incapable of adding a false positive to the proven one.
 *
 * It is isolated from the ingest path: it only READS `agents` / `anomalies` /
 * `parsed_logs` and WRITES `validation_agents`, so it can never mutate or block
 * regular ingestion. Like `getUnreportedClosedAgents`, it is self-healing.
 */

export interface ValidationCounts {
  checked: number;
  passed: number;
  /** Completed transactions with a high/critical associated analysis anomaly. */
  issues: number;
  failed: number;
  pending: number;
  /**
   * Transactions the app's validation AI agent reviewed (the residual — deterministically
   * clean but with an unproven outcome). Kept separate from `checked` so the model's blast
   * radius is a reported number: it only ever saw this many of the transactions.
   */
  aiReviewed: number;
  /** Residual transactions carrying at least one AI claim that survived re-verification. */
  aiSuspected: number;
  /**
   * AI claims DISCARDED by the admission gate (fabricated log id, predicate that did not
   * hold, no witness). This is the model's observed hallucination rate in production —
   * every one of these would have been a false positive had the claim been trusted.
   */
  aiRejected: number;
  /**
   * Reviews that could NOT be completed — model error, throttling, or a reply too mangled
   * to recover claims from. Counted separately from `aiReviewed` because a failed review
   * is not a clean one: if this is non-zero the AI stage is degraded, and treating those
   * transactions as reviewed-and-clean would be the worst possible false negative.
   */
  aiFailed: number;
  /**
   * Completed transactions that carried an associated analysis anomaly BELOW the
   * app's `qualityIssueSeverity` threshold — recorded but not surfaced as `issues`.
   * Counted so the by-design suppression is observable per app, never invisible.
   */
  suppressed: number;
}

export interface ValidationRunResult extends ValidationCounts {
  /** Per-application breakdown (application id → counts). */
  byApplication: Record<string, ValidationCounts>;
  /**
   * Deterministic checks the AI agents PROPOSED this run, aggregated by rule id and
   * ordered by how often they recurred. This is the promotion queue that keeps the model
   * out of the long-term loop: a rule that keeps recurring is one a human should encode
   * as an `ApplicationValidation.checks` predicate, after which that whole class of
   * problem is caught deterministically and the agent stops proposing it.
   */
  ruleCandidates: Array<{ id: string; application: string; title: string; rationale: string; count: number }>;
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
   * Minimum associated-anomaly severity that makes a completed transaction
   * 'completed_with_issues' (the app owns this knob; defaults to 'high').
   */
  qualityIssueSeverity?: Severity;
}

/** Severity ordering — used to pick the worst associated anomaly and to gate 'issues'. */
const SEVERITY_RANK: Record<string, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
const rank = (s?: string): number => (s ? SEVERITY_RANK[s] ?? 0 : 0);
const worstSeverity = (fs: QualityAnomaly[]): Severity | undefined =>
  fs.length ? (fs.reduce((a, b) => (rank(b.severity) > rank(a.severity) ? b : a)).severity as Severity) : undefined;
/** Does `sev` meet the app's "issues" threshold (default 'high')? */
const meetsThreshold = (sev: Severity | undefined, threshold: Severity = 'high'): boolean =>
  sev != null && rank(sev) >= rank(threshold);

// ---------------------------------------------------------------------------
// Validation AI agent configuration. The stage is bounded on every axis that
// matters — it can be switched off, it is capped per poll, and it only ever runs
// over the residual — so enabling it cannot change the cost or the latency profile
// of the poll by more than a known constant.
// ---------------------------------------------------------------------------

/** Kill switch. Set VALIDATION_AI_ENABLED=false to run deterministic validation only. */
const AI_ENABLED = (process.env.VALIDATION_AI_ENABLED ?? 'true').toLowerCase() !== 'false';
/** Hard cap on model calls per poll — bounds cost and keeps the Lambda inside its budget. */
const AI_MAX_PER_POLL = Number(process.env.VALIDATION_AI_MAX_PER_POLL ?? 10);
/** Concurrent model calls. Small: this poller is never on the critical path. */
const AI_CONCURRENCY = Number(process.env.VALIDATION_AI_CONCURRENCY ?? 3);
/**
 * Wall-clock budget for the WHOLE AI stage. The deterministic results are persisted
 * AFTER this stage, so an unbounded stage could let a slow model run the Lambda out of
 * time and drop the deterministic verdicts with it — the model would then be able to
 * break validation without ever emitting a claim. The stage stops starting new reviews
 * once the budget is spent, so the upsert always runs. Keep it well under the Lambda's
 * own timeout (`infra/lambda.tf`).
 */
const AI_DEADLINE_MS = Number(process.env.VALIDATION_AI_DEADLINE_MS ?? 60_000);
/**
 * Must be GENEROUS. The configured foundation model (GPT-OSS) is a reasoning model whose
 * hidden reasoning tokens are charged against this same budget, so the visible JSON gets
 * whatever is left. Set too low, the reply is cut off mid-claim and arrives as
 * unparseable JSON — observed in prod at 2000, which truncated every review with
 * "Unterminated string in JSON". The claims themselves are tiny; this is headroom.
 * Inherits the platform-wide ceiling (`BEDROCK_MAX_TOKENS`, see bedrock.ts) unless
 * VALIDATION_AI_MAXTOKENS is set to bound this site specifically.
 */
const AI_MAX_TOKENS = process.env.VALIDATION_AI_MAXTOKENS ? Number(process.env.VALIDATION_AI_MAXTOKENS) : undefined;

/**
 * How much of the deterministically-clean population the agent reviews:
 *   'clean'    (default) — every transaction the deterministic checks passed with no
 *                          delta. This is where the value is: a business failure behind
 *                          a 200, a denied authorizer on a completed call, are all
 *                          transactions whose outcome WAS positively derived, so the
 *                          narrower scope below never shows them to the agent at all.
 *   'unproven'           — only those the checks passed WITHOUT proving the outcome.
 *                          Fewer model calls, but it only ever sees missing-evidence
 *                          cases (mostly timeouts), where there is little to find.
 * Either way the hard invariant is identical and enforced elsewhere: the agent is never
 * given a transaction that carries a delta, and its output can only ever produce
 * `ai_suspected` — so it can neither silence a failure nor manufacture one.
 */
const AI_SCOPE = (process.env.VALIDATION_AI_SCOPE ?? 'clean').toLowerCase() === 'unproven' ? 'unproven' : 'clean';

/**
 * Reviews older than this epoch (ms) no longer count as done, so the transaction is
 * reviewed again. Bump it whenever an app's `validation.agent.md` changes: a claim is
 * only as good as the spec that produced it, and a corrected spec must be able to
 * supersede the verdicts the old one left behind — otherwise a false positive fixed in
 * the prompt stays on the board forever, because the one-shot dedup never revisits it.
 */
const AI_REVIEW_EPOCH = Number(process.env.VALIDATION_AI_REVIEW_EPOCH ?? 0);

/**
 * The default validation reasoner — a Bedrock call at temperature 0, injected into each
 * app's validation agent so the app packages never depend on Bedrock or on this engine.
 * It returns RAW TEXT: parsing lives beside the admission gate in `@log/shared`, so a
 * truncated reply can be salvaged for its complete claims rather than thrown away by a
 * strict parse here. Temperature 0 is for reproducibility of the *proposal*, not for
 * correctness — correctness comes from the gate re-executing every claim.
 */
const defaultValidationReasoner: ValidationReasoner = (system, user) =>
  converse(user, { system, temperature: 0, maxTokens: AI_MAX_TOKENS, stage: 'validation-review' });

/**
 * Run `fn` over `items` with bounded concurrency, stopping early once `deadline` passes.
 * Returns how many items were actually started, so a truncated stage can say so instead
 * of reading as full coverage.
 */
async function pool<T>(
  items: readonly T[],
  limit: number,
  deadline: number,
  fn: (item: T) => Promise<void>,
): Promise<number> {
  let next = 0;
  let started = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length && Date.now() < deadline) {
      const item = items[next++];
      if (item === undefined) continue;
      started += 1;
      await fn(item);
    }
  });
  await Promise.all(workers);
  return started;
}

/**
 * Report each application's validation AI agent as this process has it configured —
 * registry declaration AND the env that gates it. Read from the same constants the stage
 * itself uses, so the UI can never show an agent as enabled while the runtime has it off
 * (the API and the Lambda are separately configured, and have drifted before).
 */
export function validationAgentInfo(registry?: ApplicationRegistry): ValidationAgentInfo[] {
  return (registry?.all() ?? []).map((app) => {
    const declared = app.validation?.validationAgent != null;
    return {
      application: app.id,
      displayName: app.displayName,
      enabled: declared && AI_ENABLED && AI_MAX_PER_POLL > 0,
      disabledReason: !declared
        ? 'this application declares no validation agent'
        : !AI_ENABLED
          ? 'VALIDATION_AI_ENABLED=false in this runtime'
          : AI_MAX_PER_POLL <= 0
            ? 'VALIDATION_AI_MAX_PER_POLL is 0'
            : undefined,
      promptPath: app.validation?.agentPromptPath,
      scope: AI_SCOPE,
      maxPerPoll: AI_MAX_PER_POLL,
      deadlineMs: AI_DEADLINE_MS,
      reviewEpoch: AI_REVIEW_EPOCH,
    };
  });
}

/** Compare one regular agent against the anomalies + its app rules → a validation agent. */
export function validateAgent(
  agent: Pick<
    Agent,
    'messageId' | 'application' | 'status' | 'active' | 'waitingFor' | 'phases' | 'phaseTs' | 'spawnedAt' | 'closedAt'
  >,
  anomalySeverity: string | undefined,
  now: number,
  ctx: AppValidationContext = { allPhases: [] },
  qualityAnomalies: QualityAnomaly[] = [],
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

  // Still active — no anomaly is expected yet; validation is pending. But an agent
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
      expectedAnomaly: false,
      actualAnomaly: false,
      delta: overdue ? [overdue] : [],
      missingPhases: [],
      qualityAnomalies: [],
      aiFindings: [],
      detail: overdue
        ? `NEEDS ATTENTION: ${overdue}`
        : agent.waitingFor
          ? `awaiting ${agent.waitingFor} — validation pending`
          : 'validation pending',
    };
  }

  const { expected, severity: expectedSeverity } = expectedAnomalyFor(agent);
  const actualAnomaly = anomalySeverity !== undefined;
  const actualSeverity = anomalySeverity;
  const delta: string[] = [];

  // (1) Anomaly / level invariant.
  if (expected && !actualAnomaly) {
    delta.push(`missing anomaly: expected a ${expectedSeverity} anomaly for ${agent.status} agent, none found`);
  } else if (!expected && actualAnomaly) {
    delta.push(`unexpected anomaly: ${agent.status} agent should have no anomaly, found one (${actualSeverity})`);
  } else if (expected && actualAnomaly && actualSeverity !== expectedSeverity) {
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

  // (4) Associated quality anomalies — only meaningful for a completed transaction.
  const quality = agent.status === 'completed' ? qualityAnomalies : [];
  const maxQualitySeverity = worstSeverity(quality);

  // Result: a lifecycle delta is a hard failure and takes precedence. Otherwise a
  // completed transaction with a high/critical associated anomaly is surfaced as
  // 'completed_with_issues' (NOT a failure — the agent behaved correctly). A clean
  // completion, or one with only info/low anomalies, is a success.
  let result: ValidationAgent['result'];
  let detail: string;
  if (delta.length > 0) {
    result = 'failure';
    detail = delta.join('; ');
  } else if (agent.status === 'completed' && meetsThreshold(maxQualitySeverity, ctx.qualityIssueSeverity)) {
    result = 'completed_with_issues';
    detail = `completed, but ${quality.length} associated anomaly(s) — highest ${maxQualitySeverity}`;
  } else {
    result = 'success';
    detail = expected
      ? `anomaly present at ${expectedSeverity}`
      : quality.length
        ? `completed cleanly; ${quality.length} low/info anomaly(s)`
        : 'phases complete within SLA; no anomaly expected';
  }

  return {
    ...base,
    active: false,
    result,
    expectedAnomaly: expected,
    expectedSeverity,
    actualAnomaly,
    actualSeverity,
    delta,
    missingPhases,
    qualityAnomalies: quality,
    maxQualitySeverity,
    // The AI stage runs later, in the driver, and only for the residual — a purely
    // deterministic `validateAgent` call (the one the backtest replays) never has any.
    aiFindings: [],
    detail,
    closedAt: agent.closedAt ?? now,
  };
}

/**
 * Is this transaction RESIDUAL — i.e. did the deterministic engine let it pass WITHOUT
 * proving anything about it? Returns the human-readable reason when it is, else null.
 *
 * This is the gate that bounds the AI agent's blast radius, and it is deliberately
 * narrow: a transaction qualifies only when the deterministic checks produced NO delta,
 * the result is a clean `success`, and {@link deriveOutcome} could not read a terminal
 * outcome out of the logs. So the agent is never consulted about a transaction that has
 * a proven verdict — it cannot contradict one — and the population it does see is
 * exactly the one that previously passed on absence of evidence.
 */
export function residualReason(
  v: ValidationAgent,
  derived?: DerivedOutcome,
  scope: 'clean' | 'unproven' = AI_SCOPE,
): string | null {
  // The hard invariant, independent of scope: the agent is only ever shown a transaction
  // that carries NO deterministic delta and passed clean. It is never asked about a
  // failure or a completed-with-issues, so it has no verdict available to contradict.
  if (v.active) return null; // still in flight; nothing terminal to review yet
  if (v.delta.length > 0) return null; // deterministically decided — never revisited
  if (v.result !== 'success') return null; // issues/failure already carry a signal
  // The residual is the FALSE-NEGATIVE population: transactions that claim they WORKED
  // and passed every check without the outcome being proven. A transaction the agent
  // recorded as `failed` or `error` is not in it — it was already flagged, already
  // carries its high/medium anomaly, and someone is already going to look at it. Adding
  // an AI suspicion there buys nothing and actively muddies the board, because the row
  // no longer says whether it is about the known failure or something new. It is also
  // where the false positives concentrate: a failed or timed-out transaction is missing
  // evidence BY DEFINITION, which is exactly what invites a claim about what is absent.
  if (v.agentStatus !== 'completed') return null;

  if (!derived) return 'this transaction\'s logs were not loaded, so no outcome could be derived from them';
  if (derived.status === 'unknown') {
    return `the logs do not prove a terminal outcome (${derived.detail ?? 'no decisive evidence found'})`;
  }
  // The outcome WAS positively derived. Under the narrow scope that ends the review;
  // under the default it does not, because the interesting failures live exactly here —
  // a transaction whose outcome is provably 'completed' while its payload says otherwise.
  if (scope === 'unproven') return null;
  return `the outcome was derived as ${derived.status} (${derived.detail ?? 'from the logs'}) and every deterministic check passed — nothing beyond those checks has been examined`;
}

/**
 * Record one AI review on a validation agent WITHOUT letting it overturn anything. The
 * deterministic `delta` is never touched, and the result is relabelled only for a clean
 * `success` (the sole population the agent is allowed to see). Rejected-claim counts are
 * kept even when nothing is admitted, so a review that produced only hallucinations is
 * still visible rather than indistinguishable from one that found nothing.
 */
export function applyAiReview(v: ValidationAgent, outcome: AiReviewOutcome, now: number): void {
  v.aiRejected = outcome.rejected.length;
  v.aiFindings = outcome.findings;
  v.aiError = outcome.error;
  // A FAILED review is not a review. Leaving `aiReviewedAt` unset keeps the transaction
  // out of the one-shot dedup so the next poll retries it, and keeps the UI from showing
  // a broken model as "reviewed, nothing found" — the exact false reassurance this whole
  // design exists to prevent.
  if (outcome.error && !outcome.findings.length) return;
  v.aiReviewedAt = now;
  if (!outcome.findings.length) return;
  const worst = outcome.findings.reduce((a, b) => (rank(b.severity) > rank(a.severity) ? b : a));
  v.result = 'ai_suspected';
  v.detail = `AI-suspected (outcome unproven): ${outcome.findings.length} verified claim(s), highest ${worst.severity} — ${worst.title}`;
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
 * agents, the agent-lifecycle anomaly severities, and (for recently-completed
 * transactions) the window's parsed logs + analysis anomalies so it can associate
 * quality anomalies by shared log identity. Evaluates each agent against its
 * application's rules and upserts the shadow validation agents. Best-effort
 * throughout; nothing here can affect the ingest path.
 */
export async function validateAgents(
  registry?: ApplicationRegistry,
  opts: {
    now?: number;
    historyTtlMs?: number;
    qualityWindowMs?: number;
    /** Override the model call for the AI stage (tests inject a stub; prod uses Bedrock). */
    validationReasoner?: ValidationReasoner;
    /** How this pass was started — 'manual' for the dashboard's "Validate now". */
    trigger?: 'schedule' | 'manual';
  } = {},
): Promise<ValidationRunResult> {
  const now = opts.now ?? Date.now();
  const historyTtlMin = Number(process.env.INGEST_AGENT_HISTORY_TTL_MINUTES ?? 1440);
  const historyTtlMs = opts.historyTtlMs ?? historyTtlMin * 60_000;
  // How far back to associate quality anomalies. Bounds the parsed_logs read; older
  // completed transactions keep the association computed while they were recent.
  const qualityWindowMs =
    opts.qualityWindowMs ?? Number(process.env.VALIDATION_QUALITY_WINDOW_MINUTES ?? 60) * 60_000;

  const [active, history] = await Promise.all([getActiveAgents(2000), getAgentHistory(2000)]);
  const closedIds = history.map((a) => a.messageId);
  const severities = await getAgentAnomalySeverities(closedIds);

  // One log-backed pass over recently-CLOSED transactions (bounded work): re-derive
  // each outcome straight from the raw logs, associate quality anomalies by shared
  // log identity, and sanity-check the join. Older closed agents keep whatever was
  // computed while they were recent.
  const qualitySince = now - qualityWindowMs;
  const recentClosed = history.filter((a) => (a.closedAt ?? 0) >= qualitySince);
  const qualityByMsg = new Map<string, QualityAnomaly[]>();
  const derivedByMsg = new Map<string, DerivedOutcome>();
  const relatedByMsg = new Map<string, ParsedLog[]>();
  if (recentClosed.length && registry) {
    try {
      const [windowLogs, analysisAnomalies] = await Promise.all([
        queryLogs({ from: qualitySince, limit: 20_000 }),
        getNonTransactionAnomaliesSince(qualitySince, 2000),
      ]);
      // Index anomalies by each evidence logId (app-scoped so ids never cross apps).
      const byLogId = new Map<string, Anomaly[]>();
      for (const f of analysisAnomalies) {
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

        // (4) Associate quality anomalies — only meaningful for a completed transaction.
        if (a.status === 'completed') {
          const seen = new Set<string>();
          const qfs: QualityAnomaly[] = [];
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

  // (9) The validation AI agent — LAST, so every deterministic verdict above is already
  // final and the agent can only annotate what those checks left unproven. Best-effort
  // throughout: a model error, a missing prompt, or a claim that fails re-verification
  // leaves the transaction exactly as the deterministic engine decided it.
  const ruleTally = new Map<string, { id: string; application: string; title: string; rationale: string; count: number }>();
  if (registry && AI_ENABLED && AI_MAX_PER_POLL > 0) {
    const byMsg = new Map(validations.map((v) => [v.messageId, v]));
    // A residual stays inside the log-backed window for several polls, so without this
    // the same transaction would be re-sent to the model on each of them. The review is
    // one-shot; its stored result is sticky (see upsertValidationAgents).
    let alreadyReviewed = new Set<string>();
    try {
      alreadyReviewed = await getAiReviewedMessageIds(recentClosed.map((a) => a.messageId), AI_REVIEW_EPOCH);
    } catch (err) {
      console.error('validation: could not read prior AI reviews, skipping the AI stage', (err as Error).message);
      alreadyReviewed = new Set(recentClosed.map((a) => a.messageId)); // fail closed — never re-review blindly
    }
    type Residual = { v: ValidationAgent; app: ApplicationDef; reason: string; related: ParsedLog[] };
    const residuals: Residual[] = [];
    for (const a of recentClosed) {
      if (alreadyReviewed.has(a.messageId)) continue;
      const v = byMsg.get(a.messageId);
      const app = registry.byId(a.application);
      if (!v || !app?.validation?.validationAgent) continue;
      const reason = residualReason(v, derivedByMsg.get(a.messageId));
      if (!reason) continue;
      const related = relatedByMsg.get(a.messageId) ?? [];
      // With no logs there is nothing a claim could cite, so a review could only
      // hallucinate. Skip rather than spend the call.
      if (!related.length) continue;
      residuals.push({ v, app, reason, related });
    }

    const reviewed = residuals.slice(0, AI_MAX_PER_POLL);

    // SPAWN a running agent per application that actually has work this pass. The row is
    // what the dashboard renders as an "active validation agent", so an idle poll must
    // spawn nothing — otherwise the panel would show agents doing nothing, which is the
    // static roster this replaced.
    const runId = `${now}-${Math.abs(reviewed.length * 31 + validations.length)}`;
    const byAppRun = new Map<string, { id: string; reviewed: number; suspected: number; discarded: number; failed: number }>();
    for (const r of reviewed) {
      if (!byAppRun.has(r.app.id)) byAppRun.set(r.app.id, { id: `${runId}-${r.app.id}`, reviewed: 0, suspected: 0, discarded: 0, failed: 0 });
    }
    if (byAppRun.size) {
      try {
        await startValidationAgentRuns(
          [...byAppRun].map(([application, run]) => ({
            id: run.id,
            runId,
            application,
            trigger: opts.trigger ?? 'schedule',
            startedAt: now,
            queued: reviewed.filter((r) => r.app.id === application).length,
          })),
        );
      } catch (err) {
        // Best-effort: this is display state. Never let it block the actual review.
        console.error('validation: could not record agent run start', (err as Error).message);
      }
    }
    if (residuals.length > reviewed.length) {
      // Never let a cap silently read as "everything was reviewed".
      console.warn(
        `validation: AI review capped at ${AI_MAX_PER_POLL} of ${residuals.length} residual transaction(s); the rest keep their deterministic result`,
      );
    }
    const started = await pool(reviewed, AI_CONCURRENCY, now + AI_DEADLINE_MS, async ({ v, app, reason, related }) => {
      try {
        const outcome = await app.validation!.validationAgent!.review(
          {
            messageId: v.messageId,
            application: v.application,
            agentStatus: v.agentStatus,
            relatedLogs: related,
            deterministicResult: v.result,
            deterministicDetail: v.detail,
            residualReason: reason,
            phases: v.phases,
            phaseTs: v.phaseTs,
          },
          opts.validationReasoner ?? defaultValidationReasoner,
        );
        applyAiReview(v, outcome, now);
        const run = byAppRun.get(app.id);
        if (run) {
          if (outcome.error && !outcome.findings.length) run.failed += 1;
          else run.reviewed += 1;
          if (outcome.findings.length) run.suspected += 1;
          run.discarded += outcome.rejected.length;
        }
        for (const r of outcome.rejected) {
          console.warn(`validation: AI claim discarded for ${v.messageId} — ${r.reason} ("${r.title}")`);
        }
        for (const f of outcome.findings) {
          if (!f.proposedRule) continue;
          const key = `${app.id}:${f.proposedRule.id}`;
          const prev = ruleTally.get(key);
          if (prev) prev.count += 1;
          else ruleTally.set(key, { ...f.proposedRule, application: app.id, count: 1 });
        }
      } catch (err) {
        console.error(`validation: AI review failed for ${v.messageId}`, (err as Error).message);
      }
    });
    if (started < reviewed.length) {
      console.warn(
        `validation: AI stage hit its ${AI_DEADLINE_MS}ms budget after ${started} of ${reviewed.length} review(s); the rest keep their deterministic result`,
      );
    }

    // CLOSE every agent spawned above, so the dashboard stops showing it. Done in a
    // finally-ish position: the pool never rejects (each review is individually
    // try/caught), so reaching here means the pass is over one way or another.
    for (const [application, run] of byAppRun) {
      try {
        await finishValidationAgentRun(run.id, Date.now(), run, `${run.reviewed} reviewed, ${run.suspected} suspected, ${run.discarded} discarded${run.failed ? `, ${run.failed} failed` : ''}`);
      } catch (err) {
        console.error(`validation: could not close agent run for ${application}`, (err as Error).message);
      }
    }
  }

  // Close rows a killed process left open, and drop old history. Without this a Lambda
  // that times out mid-pass would leave an agent showing as active forever.
  try {
    await reapValidationAgentRuns(Date.now());
  } catch (err) {
    console.error('validation: could not reap agent runs', (err as Error).message);
  }

  // The epoch is passed so a STORED review older than it is not resurrected onto a row
  // that no longer carries one — otherwise `ai_suspected` is a ratchet that survives both
  // a corrected prompt and a narrowed residual gate.
  await upsertValidationAgents(validations, AI_REVIEW_EPOCH);
  await pruneClosedValidationAgentsOlderThan(now - historyTtlMs);

  const empty = (): ValidationCounts => ({
    checked: 0,
    passed: 0,
    issues: 0,
    failed: 0,
    pending: 0,
    aiReviewed: 0,
    aiSuspected: 0,
    aiRejected: 0,
    aiFailed: 0,
    suppressed: 0,
  });
  const byApplication: Record<string, ValidationCounts> = {};
  const total = empty();
  for (const v of validations) {
    const b = (byApplication[v.application ?? 'unknown'] ??= empty());
    b.checked += 1;
    total.checked += 1;
    const bump = (k: keyof ValidationCounts, by = 1) => {
      b[k] += by;
      total[k] += by;
    };
    if (v.result === 'success') bump('passed');
    else if (v.result === 'completed_with_issues') bump('issues');
    else if (v.result === 'failure') bump('failed');
    else if (v.result === 'ai_suspected') bump('aiSuspected');
    else bump('pending');
    // AI stage counters, kept independent of the verdict tally above so the model's
    // reach (how many it saw) and its error rate (how many claims were discarded) stay
    // legible next to the deterministic numbers instead of folded into them.
    if (v.aiReviewedAt != null) bump('aiReviewed');
    if (v.aiRejected) bump('aiRejected', v.aiRejected);
    if (v.aiError) bump('aiFailed');
    // (5-surfacing) A clean success that still carried an associated anomaly means
    // the anomaly was below the app's threshold and suppressed — count it so the
    // by-design suppression is observable per app rather than silently invisible.
    if (v.result === 'success' && v.qualityAnomalies.length > 0) bump('suppressed');
  }

  return {
    ...total,
    byApplication,
    ruleCandidates: [...ruleTally.values()].sort((a, b) => b.count - a.count),
  };
}
