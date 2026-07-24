import type { ApplicationDef } from '@log/shared';
import { APPLICATION_LOG_GROUPS, parseLogGroup } from './logGroups.js';
import { scpTransactionProtocol, scpMessageMeta } from './transactionProtocol.js';
import { scpValidationChecks } from './validationChecks.js';
import { DEFAULT_CASHMESSAGE_SAMPLES } from './samples.js';

/** The SCP application: its CloudWatch log groups + REQUEST→ACK→RESPONSE protocol. */
export const scpApplication: ApplicationDef = {
  id: 'scp',
  displayName: 'SCP',
  logGroups: APPLICATION_LOG_GROUPS,
  protocol: scpTransactionProtocol,
  // Regular ingestion agent: SCP's own REQUEST→ACK→RESPONSE transaction spec.
  transactionPromptPath: 'apps/scp/transaction.md',
  // Simulator: SCP uses the correlated cashMessage REQUEST/ACK/RESPONSE set model.
  matchLogGroup: parseLogGroup,
  defaultSamples: DEFAULT_CASHMESSAGE_SAMPLES,
  simulationMode: 'cashMessage',
  correlationLabel: 'messageId',
  // Log Assistant: SCP's grounded-Q&A prompt + its richer messageId view (an
  // ACK/RESPONSE has its own messageId plus the request's id as initMessageId).
  assistantPromptPath: 'apps/scp/qa.md',
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
  // Validation agent: validate all REQUEST→ACK→RESPONSE phases; the RESPONSE that
  // completes the transaction is expected within 30 minutes of the ACK.
  validation: {
    promptPath: 'apps/scp/validation.md',
    responseTimeoutMinutes: 30,
    responseTimeoutFrom: 'ACK',
    // A completed transaction with an associated high/critical finding is
    // "completed with issues" (surfaced, not a failure).
    qualityIssueSeverity: 'high',
    // SCP-specific: REQUEST→ACK→RESPONSE phase ordering + duplicate-phase integrity.
    // Rooted in SCP's intermediate ACK phase; apiflc (REQUEST→RESPONSE) has no ACK
    // and declares no `checks`.
    checks: scpValidationChecks,
  },
};
