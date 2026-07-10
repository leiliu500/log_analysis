import type { ApplicationDef } from '@log/shared';
import { APIFLC_LOG_GROUPS, parseApiflcLogGroup } from './logGroups.js';
import { apiflcTransactionProtocol } from './transactionProtocol.js';
import { APIFLC_SAMPLE } from './samples.js';

/** The apiflc application: its CloudWatch log groups + REQUEST→RESPONSE protocol. */
export const apiflcApplication: ApplicationDef = {
  id: 'apiflc',
  displayName: 'apiflc',
  logGroups: APIFLC_LOG_GROUPS,
  protocol: apiflcTransactionProtocol,
  // Simulator: apiflc logs are raw Lambda / API-Gateway lines — write verbatim.
  matchLogGroup: parseApiflcLogGroup,
  defaultSamples: APIFLC_SAMPLE,
  simulationMode: 'verbatim',
};
