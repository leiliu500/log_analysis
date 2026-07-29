import type { ValidationAgentDef, ValidationAgentInput } from '@log/shared';
import { renderEvidenceLogs, reviewFromSpec } from '@log/shared';

/**
 * apiflc's validation AI agent — the residual reviewer for apiflc transactions the
 * deterministic worker passed WITHOUT being able to prove the outcome from the logs.
 * It owns apiflc's evidence shaping: one call is spread across the handler, authorizer
 * and API-Gateway execution groups, and the decisive lines (the HTTP status, the
 * authorizer verdict, the Data Services reply) are a small minority of a noisy call —
 * so they are surfaced FIRST and the rest is capped, keeping the decisive facts inside
 * the model's attention instead of buried under token dumps. The joined logs arrive
 * already resolved by `apiflcRelatedLogs` (the engine calls the app's own join), and
 * every claim is re-verified against these same rows by the platform gate.
 */

/** apiflc's outcome-bearing lines: the gateway status, auth verdicts, upstream replies. */
const DECISIVE =
  /(method completed with status|received response\.\s*status|response from data services|unauthorized|forbidden|denied|expired|timed? ?out|exception|error|fedline request|correlationid)/i;

function apiflcEvidence(input: ValidationAgentInput): string {
  const rendered = renderEvidenceLogs(input.relatedLogs, 40, 300);
  const decisive: string[] = [];
  const others: string[] = [];
  for (const line of rendered) (DECISIVE.test(line) ? decisive : others).push(line);

  const received = Object.entries(input.phaseTs)
    .map(([p, ts]) => `${p}@${new Date(ts).toISOString()}`)
    .join(', ');

  return [
    `Transaction: ${input.messageId} (application apiflc, correlationID)`,
    `Protocol phases, in order: ${input.phases.join(' -> ')}`,
    `Status the ingestion agent recorded: ${input.agentStatus}`,
    `Phases received: ${received || '(none)'}`,
    '',
    'The deterministic validation worker already ran on this transaction and concluded:',
    `  result: ${input.deterministicResult}`,
    `  detail: ${input.deterministicDetail ?? '(none)'}`,
    `Why it reached you (the residual): ${input.residualReason}`,
    '',
    'LOGS — the whole correlated call across apiflc\'s handler, authorizer and API-Gateway',
    'execution groups, decisive lines first. The bracketed id is the only identifier you',
    'may cite:',
    ...(decisive.length || others.length ? [...decisive, ...others] : ['  (no correlated logs available)']),
  ].join('\n');
}

export const apiflcValidationAgent: ValidationAgentDef = {
  review: (input, reason) => reviewFromSpec('apps/apiflc/validation.agent.md', apiflcEvidence(input), input, reason),
};
