import { APIFLC_LOG_GROUPS, type ApiflcLogGroup } from './logGroups.js';

/**
 * apiflc GENERATIVE simulation — build a whole correlated call across apiflc's log
 * groups from a natural-language request that pastes NO raw logs (e.g. "simulate
 * apiflc handler / authorizer / API-Gateway-execution logs for correlationID 1234,
 * completed success"). This is the counterpart to the verbatim path (which writes
 * pasted logs as-is): here the app OWNS its log shape and synthesizes realistic
 * lines, modeled on the real handler / authorizer / execution logs, with the
 * cross-group join identifiers kept consistent so a single call lands in every
 * group at once and ingestion/validation see one transaction.
 *
 * Three outcomes are expressible, matching how the platform reads apiflc:
 *   - 'success'     : gateway HTTP 200 (+ handler RESPONSE)  → completed
 *   - 'failure'     : gateway HTTP 500 (+ handler RESPONSE)  → failed (5xx)
 *   - 'no-response' : REQUEST only, no HTTP status, no RESPONSE → agent stays
 *                     awaiting and its RESPONSE-SLA eventually breaches.
 */

export type ApiflcOutcome = 'success' | 'failure' | 'no-response';

const HANDLER: ApiflcLogGroup = APIFLC_LOG_GROUPS[0]; // /aws/lambda/adt-fca-d1-api_gateway_handler
const AUTHORIZER: ApiflcLogGroup = APIFLC_LOG_GROUPS[1]; // /aws/lambda/adt-fca-d1-api_gateway_authorizer
const BACKGROUND: ApiflcLogGroup = APIFLC_LOG_GROUPS[2]; // /aws/lambda/adt-fca-d1-api_gateway_background
const EXECUTION: ApiflcLogGroup = APIFLC_LOG_GROUPS[3]; // API-Gateway-Execution-Logs_9ioz6z9om1/d1

/** The three groups that make up one real apiflc call (background is separate). */
const CALL_GROUPS: readonly ApiflcLogGroup[] = [HANDLER, AUTHORIZER, EXECUTION];

const TS = '2026-07-02T04:34:43.329Z';
const PATH = '/d1/eddReport/exportdetailinternal/121000374/052001633/0520016333300/FF/4/2024-04-01/2024-05-01';

/** Only hex chars survive so the ids stay valid uuid / trace shapes; padded/truncated to `len`. */
function hexTail(corr: string, len: number): string {
  const hex = corr.toLowerCase().replace(/[^0-9a-f]/g, '') || '0';
  return hex.length >= len ? hex.slice(-len) : hex.padStart(len, '0');
}

/**
 * The cross-group identifiers for one call, DERIVED from the correlationID so they
 * are deterministic and distinct per transaction (two different correlationIDs never
 * entangle through a shared uuid / trace). These mirror the real links the join uses:
 *   handler.lambdaRequestId == gateway `x-amzn-RequestId`
 *   handler.correlationID   == gateway `X-Correlation-ID`
 *   authorizer.xrayTraceId  == gateway `X-Amzn-Trace-Id` Root
 */
function idsFor(corr: string): { gateway: string; lambda: string; auth: string; trace: string } {
  const t12 = hexTail(corr, 12);
  const t24 = hexTail(corr, 24);
  return {
    gateway: `68f54c61-3e54-4e02-8ccf-${t12}`,
    lambda: `45e5ece0-7dbe-490a-880b-${t12}`,
    auth: `2bef85bf-6cd7-4ea4-a9d6-${t12}`,
    trace: `1-6a45ea62-${t24}`,
  };
}

/** apiflc Lambda handler lines — each prefixed with the business `correlationID:` token. */
function handlerLines(corr: string, outcome: ApiflcOutcome): string[] {
  const { lambda } = idsFor(corr);
  const p = `${TS} ${lambda} INFO correlationID: ${corr};`;
  const lines = [
    `${p} FedLine Request: { path: '${PATH}', uriParams: { officeid: '121000374', aba: '052001633', endpoint: '0520016333300', denomination: 'FF', differencetype: '4', startdate: '2024-04-01', enddate: '2024-05-01' } }`,
    `${p} =========EddExportDetailInternal Process=========`,
    `${p} params========= { FunctionName: 'fca-tf-d1-edd-detail-internal-data-service' }`,
  ];
  // A response was received only when the call actually completed (200 or 500).
  if (outcome !== 'no-response') {
    lines.push(
      outcome === 'failure'
        ? `${p} Response from Data Services: { error: 'Internal Server Error', statusCode: 500 }`
        : `${p} Response from Data Services: { result: { reportDataList: [ { edd: { differenceDetail: { adviceNumber: 7 } } } ] } }`,
    );
  }
  return lines;
}

/** apiflc authorizer lines — no correlationID; they join the call only via the X-Ray trace id. */
function authorizerLines(corr: string): string[] {
  const { auth, trace } = idsFor(corr);
  return [
    `${TS} ${auth} INFO auth response from : { principalId: 'Fed Cash Analytics', policyDocument: { Version: '2012-10-17', Statement: [ { Action: 'execute-api:Invoke', Effect: 'Allow' } ] } }`,
    `END RequestId: ${auth}`,
    `REPORT RequestId: ${auth} Duration: 613.37 ms Billed Duration: 614 ms Memory Size: 128 MB Max Memory Used: 97 MB\tXRAY TraceId: ${trace} SegmentId: 8b16dc2be0c1976f Sampled: true`,
  ];
}

/**
 * apiflc API-Gateway execution lines — each prefixed with the gateway `(requestId)`.
 * The decisive HTTP status ("Received response. Status: N" / "Method completed with
 * status: N") lives ONLY here; it is omitted for a 'no-response' call so no outcome
 * is provable and the agent stays awaiting.
 */
function executionLines(corr: string, outcome: ApiflcOutcome): string[] {
  const { gateway, lambda, trace } = idsFor(corr);
  const g = `(${gateway})`;
  const lines = [
    `${g} Extended Request Id: f3GPZGo-ulQFWZg=`,
    `${g} Starting execution for request: ${gateway}`,
    `${g} HTTP Method: GET, Resource Path: ${PATH}`,
    `${g} Method request headers: {X-Correlation-ID=${corr}, X-Amzn-Trace-Id=Root=${trace}, User-Agent=PostmanRuntime/7.29.4}`,
    `${g} Endpoint request URI: https://lambda.us-gov-east-1.amazonaws.com/2015-03-31/functions/arn:aws-us-gov:lambda:us-gov-east-1:090087310875:function:adt-fca-d1-api_gateway_handler/invocations`,
    `${g} Sending request to https://lambda.us-gov-east-1.amazonaws.com/2015-03-31/functions/arn:aws-us-gov:lambda:us-gov-east-1:090087310875:function:adt-fca-d1-api_gateway_handler/invocations`,
  ];
  if (outcome !== 'no-response') {
    const status = outcome === 'failure' ? 500 : 200;
    lines.push(
      `${g} Received response. Status: ${status}, Integration latency: 5639 ms`,
      `${g} Endpoint response headers: {Date=Thu, 02 Jul 2026 04:34:48 GMT, Content-Type=application/json, x-amzn-RequestId=${lambda}, X-Amzn-Trace-Id=Root=${trace}}`,
      `${g} Method completed with status: ${status}`,
      `${g} AWS Integration Endpoint RequestId : ${lambda}`,
      `${g} X-ray Tracing ID : Root=${trace}`,
    );
  }
  return lines;
}

/** The synthesized lines for ONE apiflc call, per log group. */
export function synthesizeApiflcSet(corr: string, outcome: ApiflcOutcome): Array<{ group: ApiflcLogGroup; lines: string[] }> {
  return [
    { group: HANDLER, lines: handlerLines(corr, outcome) },
    { group: AUTHORIZER, lines: authorizerLines(corr) },
    { group: EXECUTION, lines: executionLines(corr, outcome) },
  ];
}

/** Increment the last run of digits (mirrors the simulator's id bumping) so each set is distinct. */
function bumpCorr(corr: string, n: number): string {
  if (n === 0) return corr;
  const m = corr.match(/\d+(?!.*\d)/s);
  if (!m || m.index === undefined) return `${corr}-${n}`;
  const next = (BigInt(m[0]) + BigInt(n)).toString();
  const padded = next.length < m[0].length ? next.padStart(m[0].length, '0') : next;
  return corr.slice(0, m.index) + padded + corr.slice(m.index + m[0].length);
}

/** The business correlationID a generative request names (e.g. "correlation id=1234"). */
export function parseApiflcCorrelationId(message: string): string | undefined {
  return message.match(/correlation\s*id\s*[=:]?\s*['"]?([A-Za-z0-9._-]+)/i)?.[1];
}

/** success (200) vs failure (5xx) vs no-response (never completed), read from the request. */
export function parseApiflcOutcome(message: string): ApiflcOutcome {
  const m = message.toLowerCase();
  if (/\b(?:without|no|missing|w\/o)\s+(?:a\s+)?response\b/.test(m)) return 'no-response';
  if (/\bfail(?:ure|ed)?\b|\breject(?:ed)?\b|\berror\b|\b5\d\d\b|\bunsuccessful\b/.test(m)) return 'failure';
  return 'success';
}

/** How many transaction sets to generate (default 1). */
export function parseApiflcCount(message: string): number {
  const m = message.match(/\b(\d{1,4})\s+(?:(?!to\b)[A-Za-z]+\s+){0,2}(?:set|log|message|transaction|call|request)/i);
  return m ? Math.max(1, Number(m[1])) : 1;
}

/** Which of apiflc's groups the request targets; defaults to a whole call (handler + authorizer + execution). */
export function parseApiflcGroups(message: string): ApiflcLogGroup[] {
  const m = message.toLowerCase();
  const groups: ApiflcLogGroup[] = [];
  if (/\bhandler\b/.test(m)) groups.push(HANDLER);
  if (/\bauthoriz/.test(m)) groups.push(AUTHORIZER);
  if (/\bexecution\b|\bapi[-\s]?gateway[-\s]?exec|\bgateway\s+exec/.test(m)) groups.push(EXECUTION);
  if (/\bbackground\b/.test(m)) groups.push(BACKGROUND);
  return groups.length ? [...new Set(groups)] : [...CALL_GROUPS];
}

/** True when a segment actually pastes raw apiflc log lines — the verbatim path owns those. */
function looksLikeRawApiflcLogs(message: string): boolean {
  return /method completed with status:|received response\.\s*status:|fedline request:|starting execution\b|endpoint request uri|auth response from|^\s*\([0-9a-f][0-9a-f-]{7,}\)/im.test(
    message,
  );
}

/**
 * Split a request into one segment per simulate command, so a prompt carrying several
 * ("(4) simulate … success  (5) simulate … failure  (6) simulate … no response") is not
 * collapsed into a single command (which would only ever honor the first correlationID /
 * outcome). Boundaries are each "simulate" keyword, else numbered "(n)" markers; a
 * single-command prompt returns one segment. Any preamble before the first boundary (e.g.
 * pasted reference logs) is dropped — it carries no command.
 */
function splitApiflcCommands(message: string): string[] {
  const idx = (re: RegExp): number[] =>
    [...message.matchAll(re)].map((m) => m.index).filter((i): i is number => i !== undefined);
  // "(n)" markers are the user's own numbering and don't collide with gateway "(uuid)"
  // ids (those aren't 1–2 digits), so prefer them; else fall back to "simulate" keywords.
  let starts = idx(/\(\d{1,2}\)/g);
  if (starts.length < 2) starts = idx(/\bsimulate\b/gi);
  if (starts.length < 2) return [message];
  const segs: string[] = [];
  for (let k = 0; k < starts.length; k++) {
    const seg = message.slice(starts[k]!, k + 1 < starts.length ? starts[k + 1]! : message.length).trim();
    if (seg) segs.push(seg);
  }
  return segs.length ? segs : [message];
}

/** Accumulate one command's synthesized lines into the per-group map. */
function addCommand(byGroup: Map<ApiflcLogGroup, string[]>, segment: string): void {
  if (looksLikeRawApiflcLogs(segment)) return; // a pasted-logs segment → verbatim path, not synth
  const corr = parseApiflcCorrelationId(segment);
  if (!corr) return; // nothing to correlate this segment's synthesized call on
  const outcome = parseApiflcOutcome(segment);
  const groups = parseApiflcGroups(segment);
  const count = parseApiflcCount(segment);
  for (let i = 0; i < count; i++) {
    for (const { group, lines } of synthesizeApiflcSet(bumpCorr(corr, i), outcome)) {
      if (!groups.includes(group)) continue;
      byGroup.set(group, [...(byGroup.get(group) ?? []), ...lines]);
    }
  }
}

/**
 * Turn a natural-language apiflc simulate request into synthesized per-group samples,
 * honoring EVERY simulate command in the prompt (each with its own correlationID and
 * outcome) and merging their lines per log group. Returns undefined when no segment is a
 * synthesizable command — i.e. the prompt only pastes raw logs (verbatim path handles it)
 * or names no correlationID.
 */
export function synthesizeApiflcFromRequest(message: string): Array<{ group: string; samples: string }> | undefined {
  const byGroup = new Map<ApiflcLogGroup, string[]>();
  for (const segment of splitApiflcCommands(message)) addCommand(byGroup, segment);

  const out = [...byGroup.entries()].map(([group, lines]) => ({ group, samples: lines.join('\n') }));
  return out.length ? out : undefined;
}
