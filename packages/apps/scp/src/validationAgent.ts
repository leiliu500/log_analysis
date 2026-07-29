import type { ParsedLog, ValidationAgentDef, ValidationAgentInput } from '@log/shared';
import { renderEvidenceLogs, reviewFromSpec } from '@log/shared';
import { scpMessageMeta } from './transactionProtocol.js';

/**
 * SCP's validation AI agent — the residual reviewer for SCP transactions the
 * deterministic worker passed WITHOUT being able to prove the outcome from the logs.
 * It owns SCP's evidence: each cashMessage line is labelled with the phase and ackCode
 * SCP's own parser reads off it, so the model does not have to re-derive SCP's XML
 * shape (and cannot get it wrong). Everything it emits is re-verified against these
 * same log rows by the platform gate before it is recorded — see `reviewFromSpec`.
 */

/** Label a line with SCP's own reading of it, so the model reasons over parsed facts. */
function scpAnnotation(log: ParsedLog): string {
  const m = scpMessageMeta(log);
  if (!m.type) return '';
  const corr = m.type === 'REQUEST' ? m.messageId : m.initMessageId;
  const parts = [m.type];
  if (corr) parts.push(`corr=${corr}`);
  if (m.messageId && m.messageId !== corr) parts.push(`own=${m.messageId}`);
  if (m.ackCode) parts.push(`ackCode=${m.ackCode}`);
  return ` <${parts.join(' ')}>`;
}

function scpEvidence(input: ValidationAgentInput): string {
  const lines = renderEvidenceLogs(input.relatedLogs).map((rendered, i) => {
    const log = input.relatedLogs[i];
    return log ? `${rendered}${scpAnnotation(log)}` : rendered;
  });
  const received = Object.entries(input.phaseTs)
    .map(([p, ts]) => `${p}@${new Date(ts).toISOString()}`)
    .join(', ');

  return [
    `Transaction: ${input.messageId} (application scp)`,
    `Protocol phases, in order: ${input.phases.join(' -> ')}`,
    `Status the ingestion agent recorded: ${input.agentStatus}`,
    `Phases received: ${received || '(none)'}`,
    '',
    'The deterministic validation worker already ran on this transaction and concluded:',
    `  result: ${input.deterministicResult}`,
    `  detail: ${input.deterministicDetail ?? '(none)'}`,
    `Why it reached you (the residual): ${input.residualReason}`,
    '',
    'LOGS — every SCP line correlated to THIS transaction. The bracketed id is the only',
    'identifier you may cite; the angle-bracketed suffix is SCP\'s own parse of the line:',
    ...(lines.length ? lines : ['  (no correlated logs available)']),
  ].join('\n');
}

export const scpValidationAgent: ValidationAgentDef = {
  review: (input, reason) => reviewFromSpec('apps/scp/validation.agent.md', scpEvidence(input), input, reason),
};
