import type { ParsedLog } from '@log/shared';
import { makeParsedLog } from '@log/shared';

/**
 * SCP-specific backtest fixtures — real-shaped cashMessage XML `parsed_logs` the
 * gold cases build on. Lives in the SCP package (not the shared backtest runner),
 * mirroring how SCP owns its protocol, prompts, join, and validation checks. Built
 * on the generic {@link makeParsedLog} factory from `@log/shared`.
 */

export const MIN = 60_000;
const SCP_STREAM = '/aws/scp/esb-cashmessage';

/** One SCP cashMessage log line (namespace-prefixed XML, as `scpMessageMeta` reads it). */
export function scpLog(
  timestamp: number,
  o: { type: 'REQUEST' | 'ACK' | 'RESPONSE'; messageId: string; initMessageId?: string; ackCode?: string },
): ParsedLog {
  const tags = [`<ns2:messageType>${o.type}</ns2:messageType>`, `<ns2:messageId>${o.messageId}</ns2:messageId>`];
  if (o.initMessageId) tags.push(`<ns2:initMessageId>${o.initMessageId}</ns2:initMessageId>`);
  if (o.ackCode) tags.push(`<ns2:ackCode>${o.ackCode}</ns2:ackCode>`);
  return makeParsedLog(SCP_STREAM, timestamp, `<ns2:cashMessage>${tags.join('')}</ns2:cashMessage>`);
}

/**
 * A full REQUEST→ACK→RESPONSE SCP transaction as three ordered log lines. `ackCode`
 * defaults to a success code; pass 'FAILED' to model a failed ACK/RESPONSE. Optional
 * `respTs` overrides the RESPONSE timestamp (to model an SLA breach or bad ordering).
 */
export function scpTransaction(
  base: number,
  messageId: string,
  o: { ackCode?: string; ackTs?: number; respTs?: number; respMsgId?: string } = {},
): ParsedLog[] {
  const ackTs = o.ackTs ?? base + 1 * MIN;
  const respTs = o.respTs ?? base + 2 * MIN;
  return [
    scpLog(base, { type: 'REQUEST', messageId }),
    scpLog(ackTs, { type: 'ACK', messageId: `${messageId}-ack`, initMessageId: messageId, ackCode: o.ackCode ?? 'OK' }),
    scpLog(respTs, { type: 'RESPONSE', messageId: o.respMsgId ?? `${messageId}-res`, initMessageId: messageId, ackCode: o.ackCode ?? 'OK' }),
  ];
}
