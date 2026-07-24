import type { ParsedLog } from '@log/shared';
import { scpMessageMeta } from './transactionProtocol.js';

/**
 * SCP-specific validation rules, layered on top of the generic finding / phase /
 * SLA / outcome checks the platform engine applies to every app. These encode
 * invariants unique to SCP's REQUEST → ACK → RESPONSE cashMessage protocol — an
 * intermediate ACK phase that apiflc (a two-phase REQUEST → RESPONSE app) does not
 * have, so apiflc supplies no equivalent (`ApplicationValidation.checks` is unset).
 *
 * Given one closed transaction's related logs, returns a human-readable delta for
 * each violation (empty = clean). Only POSITIVE evidence speaks: a phase whose log
 * is not in the window is simply not examined, never assumed missing.
 *
 *   1. Phase ordering — the cashMessage phases must arrive REQUEST ≤ ACK ≤ RESPONSE.
 *      A RESPONSE stamped before its ACK (or an ACK before its REQUEST) is a protocol
 *      violation the SLA math (which measures ACK → RESPONSE latency) would otherwise
 *      read as a negative, comfortably-in-budget latency and pass.
 *   2. No duplicate follow-ups — exactly one ACK and one RESPONSE per messageId.
 *      Two DISTINCT ACK/RESPONSE messages (different own messageIds) for one request
 *      is a retransmit/duplicate the single-agent lifecycle collapses and hides.
 *      (Re-logged identical lines share an own messageId and are NOT flagged.)
 */
export function scpValidationChecks(input: {
  messageId: string;
  agentStatus: string;
  relatedLogs: readonly ParsedLog[];
}): string[] {
  const earliestTs = new Map<string, number>();
  const ownIdsByPhase = new Map<string, Set<string>>();

  for (const l of input.relatedLogs) {
    const m = scpMessageMeta(l);
    const type = m.type;
    if (type !== 'REQUEST' && type !== 'ACK' && type !== 'RESPONSE') continue;
    // REQUEST carries the correlation as its own messageId; ACK/RESPONSE carry it as initMessageId.
    const corr = type === 'REQUEST' ? m.messageId : m.initMessageId;
    if (corr !== input.messageId) continue;

    const prev = earliestTs.get(type);
    if (prev === undefined || l.timestamp < prev) earliestTs.set(type, l.timestamp);

    if (m.messageId) {
      const set = ownIdsByPhase.get(type) ?? new Set<string>();
      set.add(m.messageId);
      ownIdsByPhase.set(type, set);
    }
  }

  const deltas: string[] = [];

  // (1) Ordering — only compare phases actually present in the window.
  const order: Array<'REQUEST' | 'ACK' | 'RESPONSE'> = ['REQUEST', 'ACK', 'RESPONSE'];
  const present = order.filter((p) => earliestTs.has(p));
  for (let i = 1; i < present.length; i += 1) {
    const earlier = present[i - 1]!;
    const later = present[i]!;
    if (earliestTs.get(later)! < earliestTs.get(earlier)!) {
      deltas.push(
        `SCP ordering violation: ${later} precedes ${earlier} (${later} @ ${new Date(earliestTs.get(later)!).toISOString()} < ${earlier} @ ${new Date(earliestTs.get(earlier)!).toISOString()})`,
      );
    }
  }

  // (2) Duplicate follow-ups — more than one DISTINCT ACK / RESPONSE for one request.
  for (const p of ['ACK', 'RESPONSE'] as const) {
    const n = ownIdsByPhase.get(p)?.size ?? 0;
    if (n > 1) deltas.push(`SCP duplicate ${p}: ${n} distinct ${p} messages for messageId ${input.messageId} (expected 1)`);
  }

  return deltas;
}
