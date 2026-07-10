import type { ApplicationDef } from '@log/shared';
import { APIFLC_LOG_GROUPS } from './logGroups.js';
import { apiflcTransactionProtocol } from './transactionProtocol.js';

/** The apiflc application: its CloudWatch log groups + REQUEST→RESPONSE protocol. */
export const apiflcApplication: ApplicationDef = {
  id: 'apiflc',
  displayName: 'apiflc',
  logGroups: APIFLC_LOG_GROUPS,
  protocol: apiflcTransactionProtocol,
};
