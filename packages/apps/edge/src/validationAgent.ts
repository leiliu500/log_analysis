import type { ValidationAgentDef, ValidationAgentInput } from '@log/shared';
import { renderEvidenceLogs, reviewFromSpec } from '@log/shared';
import { edgeMessageMeta } from './transactionProtocol.js';

function edgeEvidence(input: ValidationAgentInput): string {
  const lines = renderEvidenceLogs(input.relatedLogs, 40, 500).map((rendered, index) => {
    const meta = edgeMessageMeta(input.relatedLogs[index]?.raw ?? '');
    if (!meta) return rendered;
    const fields = [meta.type, `file=${meta.originalFile}`];
    if (meta.transferFile) fields.push(`transfer=${meta.transferFile}`);
    if (meta.xmlFile) fields.push(`xml=${meta.xmlFile}`);
    if (meta.status) fields.push(`status=${meta.status}`);
    return `${rendered} <${fields.join(' ')}>`;
  });
  const received = Object.entries(input.phaseTs)
    .map(([phase, ts]) => `${phase}@${new Date(ts).toISOString()}`)
    .join(', ');

  return [
    `Transaction: ${input.messageId} (application edge, original ZIP file name)`,
    `Protocol phases, in order: ${input.phases.join(' -> ')}`,
    `Status the ingestion agent recorded: ${input.agentStatus}`,
    `Phases received: ${received || '(none)'}`,
    '',
    'The deterministic validation worker already ran and concluded:',
    `  result: ${input.deterministicResult}`,
    `  detail: ${input.deterministicDetail ?? '(none)'}`,
    `Why it reached you: ${input.residualReason}`,
    '',
    'LOGS - every filename-correlated edge row. The bracketed id is the only logId',
    'you may cite; the angle-bracketed suffix is the edge parser\'s interpretation:',
    ...(lines.length ? lines : ['  (no correlated logs available)']),
  ].join('\n');
}

export const edgeValidationAgent: ValidationAgentDef = {
  review: (input, reason) => reviewFromSpec('apps/edge/validation.agent.md', edgeEvidence(input), input, reason),
};
