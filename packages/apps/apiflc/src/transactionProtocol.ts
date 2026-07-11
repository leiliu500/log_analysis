import type { ParsedLog, TransactionProtocol, TxEvent } from '@log/shared';

/**
 * apiflc's transaction shape is REQUEST → RESPONSE (no ACK). Unlike SCP (which
 * uses messageId on the REQUEST and initMessageId on the follow-ups), apiflc
 * correlates a REQUEST and its RESPONSE by a shared `correlationId`. This is the
 * simpler two-phase case the generic engine supports with `phases: ['RESPONSE']`.
 *
 * A single API call is logged across several groups (API-Gateway execution logs,
 * the Lambda handler, the authorizer). The business transaction is correlated by
 * the **business `correlationID`** — the one the handler logs (e.g. 1234). The
 * API-Gateway execution log carries a *different* id, the gateway `requestId`
 * (e.g. "(68f54c61-…)"), which is NOT the business correlation id: if we spawned
 * transactions off it too, one call would show up as TWO agents. So `eventOf`
 * only recognizes the business-correlated shapes:
 *   1. Structured JSON: a `messageType`/`type` of REQUEST|RESPONSE, correlated by
 *      `correlationId` (the request id is a last-resort fallback), with
 *      status/statusCode/ackCode.
 *   2. Lambda handler text: "... correlationID: <id>; FedLine Request ..." (REQUEST)
 *      and "... correlationID: <id>; Response from Data Services ..." (RESPONSE).
 * The API-Gateway execution-log lines (keyed only by the gateway requestId) are
 * treated as supporting detail, not as their own transaction — see
 * {@link fromApiGateway}, which is intentionally NOT wired into `eventOf`.
 */

function fromJson(raw: string): TxEvent | undefined {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const o = JSON.parse(trimmed) as Record<string, unknown>;
    const type = String(o.messageType ?? o.type ?? '').toUpperCase();
    if (type !== 'REQUEST' && type !== 'RESPONSE') return undefined;
    // apiflc correlates by correlationId (shared across the REQUEST + RESPONSE).
    const corrId = String(o.correlationId ?? o.requestId ?? o.id ?? '');
    if (!corrId) return undefined;
    const code = o.ackCode ?? o.status ?? o.statusCode;
    return { type, corrId, ackCode: code != null ? String(code) : undefined };
  } catch {
    return undefined;
  }
}

/**
 * Parse an API-Gateway execution-log line. Kept for reference/possible future use
 * but deliberately NOT used by {@link eventOf}: these lines are keyed by the
 * gateway `requestId`, not the business `correlationID`, so treating them as
 * transactions would double-count a single call (one agent per group). The
 * business transaction is owned by the handler logs.
 */
export function fromApiGateway(raw: string): TxEvent | undefined {
  // API Gateway execution logs prefix each line with "(<requestId>)".
  const idMatch = raw.match(/\(([a-z0-9-]{8,})\)/i);
  if (!idMatch) return undefined;
  const corrId = idMatch[1]!;
  const statusMatch = raw.match(/method completed with status:\s*(\d{3})/i);
  if (statusMatch) return { type: 'RESPONSE', corrId, ackCode: statusMatch[1] };
  // Only the execution START is the REQUEST — NOT the many "Method request
  // path/headers/body" lines (which would double-count as duplicate requests).
  if (/\bstarting execution\b/i.test(raw)) {
    return { type: 'REQUEST', corrId, ackCode: undefined };
  }
  return undefined;
}

/**
 * apiflc Lambda handler logs: "... INFO correlationID: <id>; FedLine Request: ..."
 * (REQUEST) / "... correlationID: <id>; Response from Data Services: ..." (RESPONSE),
 * correlated by the business correlationID.
 */
function fromHandler(raw: string): TxEvent | undefined {
  const idMatch = raw.match(/correlationID:\s*([A-Za-z0-9._-]+)/i);
  if (!idMatch) return undefined;
  const corrId = idMatch[1]!;
  // Strip the "correlationID: <id>;" token so it can't itself match request/response.
  const rest = raw.replace(/correlationID:\s*[A-Za-z0-9._-]+;?/gi, '');
  if (/\brequest\b/i.test(rest)) return { type: 'REQUEST', corrId, ackCode: undefined };
  if (/\bresponse\b/i.test(rest)) return { type: 'RESPONSE', corrId, ackCode: undefined };
  return undefined;
}

export const apiflcTransactionProtocol: TransactionProtocol = {
  id: 'apiflc',
  initial: 'REQUEST',
  phases: ['RESPONSE'],
  allPhases: ['REQUEST', 'RESPONSE'],
  eventOf(log: ParsedLog): TxEvent | undefined {
    // Business-correlated shapes only (structured JSON + handler correlationID).
    // API-Gateway execution logs are intentionally excluded so one call is one
    // agent — see fromApiGateway's note.
    return fromJson(log.raw) ?? fromHandler(log.raw);
  },
  isSuccess(ackCode?: string): boolean {
    if (!ackCode) return true;
    const c = ackCode.trim();
    if (/^\d{3}$/.test(c)) return Number(c) < 400; // HTTP status
    return /^(ok|success(ful)?|processed(_successfully)?|accepted|complete[d]?)$/i.test(c);
  },
};
