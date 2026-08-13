import type { ApplicationDef } from '@log/shared';
import { edgeIngestionAgent } from './agent.js';
import { EDGE_LOG_GROUPS, parseEdgeLogGroup, splitEdgeByLogGroup } from './logGroups.js';
import { EDGE_SFTP_SAMPLE } from './samples.js';
import { synthesizeEdgeFromRequest } from './simulateEdge.js';
import { edgeTransactionProtocol } from './transactionProtocol.js';

export const edgeApplication: ApplicationDef = {
  id: 'edge',
  displayName: 'edge',
  logGroups: EDGE_LOG_GROUPS,
  protocol: edgeTransactionProtocol,
  ingestionAgent: edgeIngestionAgent,
  matchLogGroup: parseEdgeLogGroup,
  splitByLogGroup: splitEdgeByLogGroup,
  synthesizeFromRequest: synthesizeEdgeFromRequest,
  defaultSamples: EDGE_SFTP_SAMPLE,
  simulationMode: 'verbatim',
  correlationLabel: 'fileName',
  simulateUnderstandingPromptPath: 'apps/edge/simulate.understand.md',
};
