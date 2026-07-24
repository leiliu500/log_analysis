import type { ValidationAgent } from '@log/shared';
import { applicationRegistry } from '@log/applications';
import { appContextFor, deriveOutcome, relatedLogsFor, reconcileDelta, validateAgent } from '@log/analysis';
import type { CaseResult, GoldCase } from './types.js';

/**
 * Replay ONE gold case through the real validation engine — the exact code path the
 * deployed validation poller runs, minus the DB I/O:
 *   1. resolve the app's context from the real registry (phases + SLA config);
 *   2. resolve the transaction's related logs via the app's real join;
 *   3. re-derive the terminal outcome straight from those logs (app hook or generic);
 *   4. run `validateAgent` (finding invariant, phase completeness, SLA, evidence,
 *      status-vs-reality, quality findings);
 *   5. apply the app's own extra checks (SCP ordering/duplicate) and any
 *      system-of-record reconciliation.
 * Nothing here is re-implemented — it calls the shipped functions, so a regression in
 * the engine shows up as a regression here.
 */
export function runCase(gc: GoldCase): CaseResult {
  const app = applicationRegistry.byId(gc.app);
  const ctx = appContextFor(gc.agent, applicationRegistry);
  const related = relatedLogsFor(app, gc.agent.messageId, gc.logs);

  const derived = deriveOutcome(app, gc.agent.messageId, related, ctx);
  // The driver sets windowComplete from whether the tx's spawn is inside the loaded
  // window; the case declares it directly (default true).
  derived.windowComplete = gc.windowComplete ?? true;

  const v: ValidationAgent = validateAgent(
    gc.agent,
    gc.findingSeverity,
    gc.now,
    ctx,
    gc.qualityFindings ?? [],
    derived,
  );

  // Post-validate steps the driver applies (see validateAgents): app-specific checks
  // then system-of-record reconciliation. Both append deltas that force a failure.
  const forceFailure = (msg: string): void => {
    v.delta = [...v.delta, msg];
    v.result = 'failure';
    v.detail = v.delta.join('; ');
  };

  if (!gc.agent.active) {
    for (const d of app?.validation?.checks?.({ messageId: gc.agent.messageId, agentStatus: gc.agent.status, relatedLogs: related }) ?? []) {
      forceFailure(d);
    }
    if (gc.reconcile) {
      const msg = reconcileDelta(gc.agent.status, gc.reconcile);
      if (msg) forceFailure(msg);
    }
  }

  const predictedProblem = v.result === 'failure' || v.result === 'completed_with_issues';
  const expectedProblem = gc.expected === 'failure' || gc.expected === 'completed_with_issues';
  const classification: CaseResult['classification'] =
    predictedProblem && expectedProblem
      ? 'true-positive'
      : !predictedProblem && !expectedProblem
        ? 'true-negative'
        : predictedProblem
          ? 'false-positive'
          : 'false-negative';

  return {
    case: gc,
    actual: v.result,
    delta: v.delta,
    predictedProblem,
    expectedProblem,
    classification,
    resultMatched: v.result === gc.expected,
    deltaMatched: gc.expectDelta ? v.delta.some((d) => gc.expectDelta!.test(d)) : null,
  };
}
