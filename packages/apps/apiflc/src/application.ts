import type { ApplicationDef } from '@log/shared';
import { APIFLC_LOG_GROUPS, parseApiflcLogGroup, splitApiflcByLogGroup } from './logGroups.js';
import { apiflcTransactionProtocol } from './transactionProtocol.js';
import { apiflcRelatedLogs } from './join.js';
import { apiflcDeriveOutcome } from './httpOutcomes.js';
import { apiflcIngestionAgent } from './agent.js';
import { apiflcReconcile } from './reconcile.js';
import { APIFLC_SAMPLE } from './samples.js';

/** The apiflc application: its CloudWatch log groups + REQUEST→RESPONSE protocol. */
export const apiflcApplication: ApplicationDef = {
  id: 'apiflc',
  displayName: 'apiflc',
  logGroups: APIFLC_LOG_GROUPS,
  protocol: apiflcTransactionProtocol,
  // Dynamic ingestion agent: apiflc's REQUEST→RESPONSE transaction spec (the LLM system
  // prompt) + apiflc's own agent, which joins the gateway execution log so it reasons over
  // the HTTP status. All apiflc-specific correlation lives in the app package.
  transactionPromptPath: 'apps/apiflc/transaction.md',
  ingestionAgent: apiflcIngestionAgent,
  // Simulator: apiflc logs are raw Lambda / API-Gateway lines — write verbatim.
  // A single paste may target several groups (handler / authorizer / execution).
  matchLogGroup: parseApiflcLogGroup,
  splitByLogGroup: splitApiflcByLogGroup,
  // Log Assistant: one apiflc call is logged under three different ids, so resolve
  // a question's id to the whole call (handler + authorizer + gateway execution).
  relatedLogs: apiflcRelatedLogs,
  // Validation: re-derive the terminal outcome from the gateway HTTP status (which
  // no protocol event carries), so an agent that recorded a 500 as `completed` is
  // caught by the status-vs-reality check.
  deriveOutcome: apiflcDeriveOutcome,
  defaultSamples: APIFLC_SAMPLE,
  simulationMode: 'verbatim',
  correlationLabel: 'correlationID',
  // apiflc owns its Simulator understanding prompt (reads its correlationID).
  simulateUnderstandingPromptPath: 'apps/apiflc/simulate.understand.md',
  // Log Assistant: apiflc's grounded-Q&A prompt. It has no assistantMeta — the
  // assistant derives (type, id=corrId, ackCode) from the REQUEST→RESPONSE
  // protocol's eventOf (apiflc's own id IS its correlationID).
  assistantPromptPath: 'apps/apiflc/qa.md',
  // Validation agent: validate all REQUEST→RESPONSE phases; the RESPONSE that
  // completes the transaction is expected within 2 minutes of the REQUEST.
  validation: {
    promptPath: 'apps/apiflc/validation.md',
    responseTimeoutMinutes: 2,
    responseTimeoutFrom: 'REQUEST',
    // A completed transaction with an associated high/critical anomaly (e.g. a
    // high integration-latency anomaly on a 200) is "completed with issues".
    qualityIssueSeverity: 'high',
    // System-of-record cross-check against Data Services (env-configured; disabled
    // until APIFLC_RECONCILE_URL is set).
    reconcile: apiflcReconcile,
  },
};
