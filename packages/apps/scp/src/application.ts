import type { ApplicationDef } from '@log/shared';
import { APPLICATION_LOG_GROUPS, parseLogGroup } from './logGroups.js';
import { scpTransactionProtocol } from './transactionProtocol.js';
import { DEFAULT_CASHMESSAGE_SAMPLES } from './samples.js';

/** The SCP application: its CloudWatch log groups + REQUEST→ACK→RESPONSE protocol. */
export const scpApplication: ApplicationDef = {
  id: 'scp',
  displayName: 'SCP',
  logGroups: APPLICATION_LOG_GROUPS,
  protocol: scpTransactionProtocol,
  // Simulator: SCP uses the correlated cashMessage REQUEST/ACK/RESPONSE set model.
  matchLogGroup: parseLogGroup,
  defaultSamples: DEFAULT_CASHMESSAGE_SAMPLES,
  simulationMode: 'cashMessage',
  correlationLabel: 'messageId',
};
