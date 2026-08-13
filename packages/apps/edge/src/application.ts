import type { ApplicationDef } from '@log/shared';
import { edgeIngestionAgent } from './agent.js';
import { EDGE_LOG_GROUPS, parseEdgeLogGroup, splitEdgeByLogGroup } from './logGroups.js';
import { EDGE_SFTP_SAMPLE } from './samples.js';
import { synthesizeEdgeFromRequest } from './simulateEdge.js';
import { edgeMessageMeta, edgeTransactionProtocol } from './transactionProtocol.js';
import { edgeRelatedLogs } from './join.js';
import { edgeDeriveOutcome } from './outcomes.js';
import { edgeValidationChecks } from './validationChecks.js';
import { edgeValidationAgent } from './validationAgent.js';

export const edgeApplication: ApplicationDef = {
  id: 'edge',
  displayName: 'edge',
  logGroups: EDGE_LOG_GROUPS,
  protocol: edgeTransactionProtocol,
  transactionPromptPath: 'apps/edge/transaction.md',
  ingestionAgent: edgeIngestionAgent,
  relatedLogs: edgeRelatedLogs,
  deriveOutcome: edgeDeriveOutcome,
  matchLogGroup: parseEdgeLogGroup,
  splitByLogGroup: splitEdgeByLogGroup,
  synthesizeFromRequest: synthesizeEdgeFromRequest,
  defaultSamples: EDGE_SFTP_SAMPLE,
  simulationMode: 'verbatim',
  // Display label only. edgeMessageMeta extracts the value from each format's
  // embedded ZIP path/field; the raw logs do not contain a `fileName=` label.
  correlationLabel: 'fileName',
  simulateUnderstandingPromptPath: 'apps/edge/simulate.understand.md',
  assistantPromptPath: 'apps/edge/qa.md',
  assistantMeta(log) {
    const meta = edgeMessageMeta(log.raw);
    if (!meta) return undefined;
    return {
      type: meta.type,
      id: meta.originalFile,
      corrId: meta.corrId,
      ackCode: meta.status,
    };
  },
  validation: {
    // The CloudWatch audit/processing phase is expected within 10 minutes of BPS.
    responseTimeoutMinutes: 10,
    responseTimeoutFrom: 'BPS',
    qualityIssueSeverity: 'high',
    checks: edgeValidationChecks,
    agentPromptPath: 'apps/edge/validation.agent.md',
    validationAgent: edgeValidationAgent,
  },
};
