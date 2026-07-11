import type { ApplicationDef } from '@log/shared';
import { APPLICATION_LOG_GROUPS, parseLogGroup } from './logGroups.js';
import { scpTransactionProtocol, scpMessageMeta } from './transactionProtocol.js';
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
  // Log Assistant: SCP's grounded-Q&A prompt + its richer messageId view (an
  // ACK/RESPONSE has its own messageId plus the request's id as initMessageId).
  assistantPromptPath: 'apps/scp/analyze.md',
  assistantMeta(log) {
    const m = scpMessageMeta(log);
    if (m.type !== 'REQUEST' && m.type !== 'ACK' && m.type !== 'RESPONSE') return undefined;
    return {
      type: m.type,
      id: m.messageId,
      corrId: m.type === 'REQUEST' ? m.messageId : m.initMessageId,
      ackCode: m.ackCode,
    };
  },
};
