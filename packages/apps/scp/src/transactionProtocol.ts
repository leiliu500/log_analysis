import type { ParsedLog, TransactionProtocol, TxEvent } from '@log/shared';

/** Read the inner text of an XML tag (namespace-prefix tolerant). */
function xmlTag(raw: string, tag: string): string | undefined {
  const m = raw.match(new RegExp(`<(?:[\\w.-]+:)?${tag}>\\s*([^<]+?)\\s*</(?:[\\w.-]+:)?${tag}>`, 'i'));
  return m ? m[1] : undefined;
}

/** ackCodes that denote a successful ACK/RESPONSE in the SCP/cashMessage domain. */
const OK_CODES = /^(OK|SUCCESS|PROCESSED_SUCCESSFULLY|ACCEPTED|COMPLETE|COMPLETED)$/i;

/** The SCP/cashMessage transaction fields read from one log. */
export interface ScpMessageMeta {
  /** REQUEST | ACK | RESPONSE (uppercased), if this is a transaction message. */
  type?: string;
  /** The message's own id. */
  messageId?: string;
  /** For an ACK/RESPONSE, the correlated REQUEST's messageId. */
  initMessageId?: string;
  ackCode?: string;
}

/**
 * Read the SCP/cashMessage transaction fields from a log. This is the single
 * source of the SCP XML shape: the {@link scpTransactionProtocol} derives its
 * generic event from it, and the API's analysis-agent uses it for the richer
 * messageId/initMessageId view it needs when answering log questions.
 */
export function scpMessageMeta(log: ParsedLog): ScpMessageMeta {
  const type =
    xmlTag(log.raw, 'messageType')?.toUpperCase() ??
    (typeof log.fields?.messageType === 'string' ? (log.fields.messageType as string).toUpperCase() : undefined);
  return {
    type,
    messageId: xmlTag(log.raw, 'messageId'),
    initMessageId: xmlTag(log.raw, 'initMessageId'),
    ackCode: xmlTag(log.raw, 'ackCode'),
  };
}

/** True when an ackCode denotes success in the SCP domain (no code = success). */
export function isScpAckSuccess(ackCode?: string): boolean {
  return !ackCode || OK_CODES.test(ackCode);
}

/**
 * The SCP (FRB cashMessage) transaction protocol. A transaction is a REQUEST
 * followed by an ACK and a RESPONSE, correlated by messageId: the REQUEST carries
 * the id as `<messageId>`, and its ACK/RESPONSE carry it as `<initMessageId>`. An
 * ACK/RESPONSE carries an `<ackCode>` that must be a success code.
 *
 * This is the application-specific knowledge the generic platform engine
 * (agent lifecycle + bulk transaction analyzer in `@log/analysis`) is injected
 * with. Another application with a different shape (e.g. REQUEST → RESPONSE only)
 * ships its own protocol; the engine is unchanged.
 */
export const scpTransactionProtocol: TransactionProtocol = {
  id: 'scp',
  initial: 'REQUEST',
  phases: ['ACK', 'RESPONSE'],
  allPhases: ['REQUEST', 'ACK', 'RESPONSE'],
  eventOf(log: ParsedLog): TxEvent | undefined {
    const m = scpMessageMeta(log);
    if (m.type !== 'REQUEST' && m.type !== 'ACK' && m.type !== 'RESPONSE') return undefined;
    const corrId = m.type === 'REQUEST' ? m.messageId : m.initMessageId;
    if (!corrId) return undefined;
    return { type: m.type, corrId, ackCode: m.ackCode };
  },
  isSuccess: isScpAckSuccess,
  /**
   * An SCP entry begins at a `cashMessage` OPENING TAG — and only there.
   *
   * A bare `<messageType>REQUEST</messageType>` line must NOT start an entry: it is a
   * continuation inside the envelope, and treating it as a start splits one message into
   * two entries so neither half carries both the type and the id. The self-contained
   * single-record case needs no clause here — the engine already forces a start for any
   * record that resolves to a complete event on its own.
   *
   * Without this hook every cashMessage line looks like a continuation to the generic AWS
   * heuristic, so a whole stream would coalesce into ONE entry and every message after the
   * first would be lost.
   */
  startsEntry(log: ParsedLog): boolean {
    return /<[\w.-]*:?cashMessage[\s>]/i.test(log.raw ?? '');
  },
};
