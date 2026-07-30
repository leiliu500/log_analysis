import type { AgentPromptContext, IngestionAgent, ParsedLog } from '@log/shared';
import { decideFromSpec } from '@log/shared';
import { apiflcRelatedLogs } from './join.js';
import { apiflcTransactionProtocol } from './transactionProtocol.js';
import { apiflcGatewayStatus } from './httpOutcomes.js';

/** The API-Gateway HTTP status line — apiflc's decisive outcome, and the ONLY thing that
 *  should re-open reasoning for an already-awaiting agent. It carries no correlationID and
 *  no protocol event, so it never schedules the transaction on its own. */
const HTTP_STATUS = /(?:received response\.\s*status|method completed with status):\s*\d{3}/i;

/**
 * apiflc's scheduling hook ({@link ApplicationDef.pendingSignals}). An apiflc agent that
 * has seen its REQUEST/RESPONSE sits `awaiting` until the gateway HTTP status arrives — but
 * that status is a non-event gateway log, so nothing would re-reason the agent and it would
 * time out. This returns each active correlationID whose correlated call now carries an HTTP
 * status in the window, so the engine re-reasons it and it completes on the real outcome.
 */
export function apiflcPendingSignals(window: readonly ParsedLog[], activeIds: readonly string[]): string[] {
  return activeIds.filter((id) =>
    apiflcRelatedLogs(id, window).some((l) => HTTP_STATUS.test(l.raw ?? l.message ?? '')),
  );
}

/**
 * apiflc's dynamic ingestion agent. It OWNS apiflc's correlation: one call is logged
 * across the handler, authorizer and API-Gateway execution groups under different ids,
 * and the decisive HTTP status ("Method completed with status: 200") lives ONLY in the
 * gateway execution log — no protocol event carries it. {@link apiflcRelatedLogs} joins
 * the whole call so that status is the evidence the agent reasons over, per
 * `apps/apiflc/transaction.md`. None of this leaks into the platform engine; the engine
 * just calls {@link IngestionAgent.decide} and injects the model.
 */
// The transaction-decisive apiflc lines: the phase markers and — crucially — the gateway
// HTTP status. Everything else in the correlated call (auth tokens, full JSON response
// bodies, header dumps) is noise that only makes the reasoning model burn tokens, so we
// surface the decisive lines FIRST and cap the rest.
const DECISIVE = /(method completed with status|received response\.\s*status|response from data services|fedline request|x-correlation-id|correlationid)/i;

function apiflcEvidence(ctx: AgentPromptContext): string {
  const raw = apiflcRelatedLogs(ctx.messageId, ctx.window)
    .map((l) => l.raw ?? l.message)
    .filter(Boolean);
  const decisive = raw.filter((l) => DECISIVE.test(l));
  const others = raw.filter((l) => !DECISIVE.test(l));
  const picked = [...decisive, ...others].slice(0, 25).map((l) => `  ${l.slice(0, 200)}`);
  return [
    `Transaction: ${ctx.messageId} (application apiflc)`,
    `Protocol phases, in order: ${apiflcTransactionProtocol.allPhases.join(' -> ')}`,
    `Current status: ${ctx.currentStatus}`,
    `Phases received so far: ${Object.keys(ctx.phaseTs).join(', ') || '(none)'}`,
    '',
    'New protocol events this cycle (oldest first):',
    ...(ctx.eventLines.length ? ctx.eventLines.map((l) => `  ${l.slice(0, 200)}`) : ['  (none)']),
    '',
    'Correlated call logs — every apiflc group for THIS transaction (handler, authorizer,',
    'API-Gateway execution), decisive lines first. The HTTP status appears ONLY here and in',
    'no protocol event above; read it as the authoritative outcome per the spec:',
    ...(picked.length ? picked : ['  (no correlated logs this cycle)']),
  ].join('\n');
}

/**
 * apiflc's DETERMINISTIC fast path — deliberately narrower than SCP's, because apiflc's
 * decisive fact is NOT on a protocol event. The outcome is the API-Gateway HTTP status,
 * which lives only in the execution log keyed by the gateway requestId. So:
 *
 *   a gateway HTTP status is present  ⇒ 2xx/3xx completed, 4xx/5xx failed (high)
 *   no status yet                     ⇒ awaiting — the phases alone prove nothing
 *
 * The crucial asymmetry versus SCP: a handler RESPONSE line is NOT a completion here. A
 * 500 logs a RESPONSE too, so treating the completing phase as success — which the
 * generic rule would do — is precisely the mis-recorded outcome (`a 500 recorded as
 * completed`) that the validation engine's status-vs-reality check exists to catch. Only
 * the status decides, and until it lands this returns `awaiting` rather than guessing.
 *
 * It reuses {@link apiflcDeriveOutcome} — the same reading the validator uses — over the
 * joined call. Where that returns `unknown`, the transaction stays awaiting and
 * `apiflcPendingSignals` re-schedules it once the status appears.
 */
function apiflcFastPath(ctx: AgentPromptContext) {
  const related = apiflcRelatedLogs(ctx.messageId, ctx.window);
  if (!related.length) return null; // nothing joined yet — let the model look at the events

  // ONLY the gateway status decides. Deliberately stricter than apiflcDeriveOutcome,
  // which also accepts a bare handler RESPONSE as `completed` — a documented open gap in
  // the gold corpus. A validator may be lenient there because it is only comparing two
  // readings; the code that RECORDS the outcome may not, or it would mark an unproven
  // call successful and the validator would then agree with itself.
  const http = apiflcGatewayStatus(related);
  if (http) {
    return http.status >= 400
      ? { status: 'failed' as const, severity: 'high' as const, detail: `API Gateway returned HTTP ${http.status}` }
      : { status: 'completed' as const, detail: `HTTP ${http.status} status observed in gateway logs` };
  }

  // No status yet. Keep waiting rather than inventing an outcome — the wall-clock timeout
  // is the backstop, and apiflcPendingSignals re-opens this the moment the status lands.
  const seen = new Set([...Object.keys(ctx.phaseTs), ...ctx.phasesThisCycle]);
  if (!seen.size) return null;
  const proto = apiflcTransactionProtocol;
  return {
    status: 'awaiting' as const,
    waitingFor: proto.phases[proto.phases.length - 1] ?? 'RESPONSE',
    detail: 'Awaiting the API-Gateway HTTP status that decides this transaction',
  };
}

export const apiflcIngestionAgent: IngestionAgent = {
  fastPath: apiflcFastPath,
  decide: (ctx, reason) => decideFromSpec('apps/apiflc/transaction.md', apiflcEvidence(ctx), reason),
};
