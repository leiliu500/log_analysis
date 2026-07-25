import type { AgentPromptContext, IngestionAgent, ParsedLog } from '@log/shared';
import { decideFromSpec } from '@log/shared';
import { apiflcRelatedLogs } from './join.js';
import { apiflcTransactionProtocol } from './transactionProtocol.js';

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

export const apiflcIngestionAgent: IngestionAgent = {
  decide: (ctx, reason) => decideFromSpec('apps/apiflc/transaction.md', apiflcEvidence(ctx), reason),
};
