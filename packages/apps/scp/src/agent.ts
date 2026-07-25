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

export const scpIngestionAgent: IngestionAgent = {
  decide: (ctx, reason) => decideFromSpec('apps/scp/transaction.md', scpEvidence(ctx), reason),
};
