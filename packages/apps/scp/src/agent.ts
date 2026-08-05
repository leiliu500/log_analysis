import type { AgentPromptContext, IngestionAgent } from '@log/shared';
import { decideFromSpec } from '@log/shared';
import { scpTransactionProtocol } from './transactionProtocol.js';

/**
 * SCP's dynamic ingestion agent. SCP's decisive ackCode rides on its own protocol events
 * (the cashMessage REQUEST/ACK/RESPONSE XML), so — unlike apiflc — it needs no cross-group
 * join: the evidence is those events, and the agent reasons the transition against
 * `apps/scp/transaction.md`. The engine only dispatches to it and injects the model.
 */
function scpEvidence(ctx: AgentPromptContext): string {
  return [
    `Transaction: ${ctx.messageId} (application scp)`,
    `Protocol phases, in order: ${scpTransactionProtocol.allPhases.join(' -> ')}`,
    `Current status: ${ctx.currentStatus}`,
    `Phases received so far: ${Object.keys(ctx.phaseTs).join(', ') || '(none)'}`,
    ctx.ackCode ? `Decisive ackCode seen: ${ctx.ackCode}` : '',
    '',
    'New protocol events this cycle (oldest first) — reason over these per the spec:',
    ...(ctx.eventLines.length ? ctx.eventLines.map((l) => `  ${l.slice(0, 500)}`) : ['  (none)']),
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * SCP's DETERMINISTIC fast path. SCP is the easy case: every deciding fact rides on the
 * cashMessage event itself, so most transitions need no reasoning at all.
 *
 *   a non-success ackCode on any phase  ⇒ failed  (high)
 *   RESPONSE received, all codes success ⇒ completed
 *   otherwise, phases still accumulating ⇒ awaiting the next missing phase
 *
 * Anything that does not match — an unrecognised phase, a RESPONSE that arrived without
 * the ACK that should precede it, no phases at all — returns null and goes to the model,
 * which is where genuinely odd shapes belong. The point is to stop spending a model call
 * on "REQUEST arrived, now await ACK", which is the overwhelming majority of transitions
 * and is not a judgement call.
 */
function scpFastPath(ctx: AgentPromptContext) {
  const { allPhases, phases: followUps } = scpTransactionProtocol;
  const completing = followUps[followUps.length - 1]; // RESPONSE
  const seen = new Set(Object.keys(ctx.phaseTs));
  for (const t of ctx.phasesThisCycle) seen.add(t);

  // Only reason about phases this protocol actually declares.
  if ([...seen].some((p) => !allPhases.includes(p))) return null;
  if (seen.size === 0) return null;

  // (1) A failure code is decisive wherever it appears.
  if (ctx.ackCode && !scpTransactionProtocol.isSuccess(ctx.ackCode)) {
    return { status: 'failed' as const, severity: 'high' as const, detail: `Non-success ackCode (${ctx.ackCode}) received` };
  }

  // (2) The completing phase with no failure code ⇒ done. Require the earlier phases too:
  // a RESPONSE without its ACK is exactly the out-of-order shape SCP's validation checks
  // flag, so it is not something to decide mechanically.
  if (completing && seen.has(completing)) {
    const missing = allPhases.filter((p) => p !== completing && !seen.has(p));
    if (missing.length) return null; // out-of-order / incomplete — let the model look
    return { status: 'completed' as const, detail: `All phases received with a success ackCode (${ctx.ackCode ?? 'none'})` };
  }

  // (3) Still in flight — await the next phase the protocol expects.
  const next = allPhases.find((p) => !seen.has(p));
  if (!next) return null;
  return { status: 'awaiting' as const, waitingFor: next, detail: `Awaiting ${next}` };
}

export const scpIngestionAgent: IngestionAgent = {
  fastPath: scpFastPath,
  decide: (ctx, reason) => decideFromSpec('apps/scp/transaction.md', scpEvidence(ctx), reason),
};
