import type { AgentPromptContext, IngestionAgent, TransitionDecision } from '@log/shared';
import { edgeTransactionProtocol } from './transactionProtocol.js';

function edgeFastPath(ctx: AgentPromptContext): TransitionDecision | null {
  const seen = new Set([...Object.keys(ctx.phaseTs), ...ctx.phasesThisCycle]);
  if (![...seen].every((phase) => edgeTransactionProtocol.allPhases.includes(phase))) return null;
  if (!seen.size) return null;
  if (ctx.ackCode && !edgeTransactionProtocol.isSuccess(ctx.ackCode)) {
    return { status: 'failed', severity: 'high', detail: `Non-success edge status (${ctx.ackCode}) received` };
  }
  if (edgeTransactionProtocol.allPhases.every((phase) => seen.has(phase))) {
    return { status: 'completed', detail: 'SFTP, BPS, and CloudWatch processing logs received' };
  }
  const next = edgeTransactionProtocol.allPhases.find((phase) => !seen.has(phase));
  return next
    ? { status: 'awaiting', waitingFor: next, detail: `Awaiting ${next} log for the edge file` }
    : null;
}

/** Edge transitions are determined entirely from its three filename-correlated phases. */
export const edgeIngestionAgent: IngestionAgent = {
  fastPath: edgeFastPath,
  async decide(ctx): Promise<TransitionDecision | null> {
    return edgeFastPath(ctx);
  },
};
