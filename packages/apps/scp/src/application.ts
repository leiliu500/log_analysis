import type { ApplicationDef } from '@log/shared';
import { APPLICATION_LOG_GROUPS } from './logGroups.js';
import { scpTransactionProtocol } from './transactionProtocol.js';

/** The SCP application: its CloudWatch log groups + REQUEST→ACK→RESPONSE protocol. */
export const scpApplication: ApplicationDef = {
  id: 'scp',
  displayName: 'SCP',
  logGroups: APPLICATION_LOG_GROUPS,
  protocol: scpTransactionProtocol,
};
