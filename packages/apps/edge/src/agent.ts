import type { AgentPromptContext, IngestionAgent, TransitionDecision } from '@log/shared';
import { decideFromSpec } from '@log/shared';
import { edgeMessageMeta, edgeTransactionProtocol } from './transactionProtocol.js';

function edgeEvidence(ctx: AgentPromptContext): string {
  return [
    `Transaction: ${ctx.messageId} (application edge, correlated by original ZIP file name)`,
    `Protocol phases, in order: ${edgeTransactionProtocol.allPhases.join(' -> ')}`,
    `Current status: ${ctx.currentStatus}`,
    `Phases received so far: ${Object.keys(ctx.phaseTs).join(', ') || '(none)'}`,
    ctx.ackCode ? `Latest explicit status: ${ctx.ackCode}` : '',
    '',
    'New edge log events this cycle (oldest first):',
    ...(ctx.eventLines.length ? ctx.eventLines.map((line) => `  ${line.slice(0, 600)}`) : ['  (none)']),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function edgeFastPath(ctx: AgentPromptContext): TransitionDecision | null {
  const seen = new Set([...Object.keys(ctx.phaseTs), ...ctx.phasesThisCycle]);
  if (![...seen].every((phase) => edgeTransactionProtocol.allPhases.includes(phase))) return null;
  if (!seen.size) return null;

  // Inspect every new line, not only ctx.ackCode (which is the last status seen).
  // If duplicate BPS lines disagree, a later SUCCESS must not hide an earlier failure.
  const statuses = [ctx.ackCode, ...ctx.eventLines.map((line) => edgeMessageMeta(line)?.status)].filter(
    (status): status is string => !!status,
  );
  const failure = statuses.find((status) => !edgeTransactionProtocol.isSuccess(status));
  if (failure) {
    return { status: 'failed', severity: 'high', detail: `Non-success edge status (${failure}) received` };
  }
  if (edgeTransactionProtocol.allPhases.every((phase) => seen.has(phase))) {
    return { status: 'completed', detail: 'SFTP, BPS, and CloudWatch processing logs received' };
  }
  const next = edgeTransactionProtocol.allPhases.find((phase) => !seen.has(phase));
  return next
    ? { status: 'awaiting', waitingFor: next, detail: `Awaiting ${next} log for the edge file` }
    : null;
}

/** Edge's app-owned ingestion agent; ordinary flows use the deterministic fast path. */
export const edgeIngestionAgent: IngestionAgent = {
  fastPath: edgeFastPath,
  decide: (ctx, reason) => decideFromSpec('apps/edge/transaction.md', edgeEvidence(ctx), reason),
};
