import type { ParsedLog } from '@log/shared';

/**
 * Join apiflc's three log groups (handler, authorizer, API-Gateway execution) into
 * single transactions and surface each call's HTTP outcome for the Log Assistant.
 *
 * A single API call is logged across all three groups under DIFFERENT ids, and the
 * HTTP status ("Received response. Status: 200 …" / "Method completed with status:
 * 200") lives ONLY in the execution log, keyed by the gateway requestId. That line
 * carries no transaction type, so it never appears in the correlated
 * REQUEST/RESPONSE table the assistant otherwise sees. We union log records by ANY
 * shared identifier so the status resolves back to the business correlationID:
 *   handler.correlationID   == gateway `X-Correlation-ID`      (handler ↔ gateway)
 *   handler.lambdaRequestId == gateway `x-amzn-RequestId`      (handler ↔ gateway)
 *   authorizer.xrayTraceId  == gateway `X-Amzn-Trace-Id` Root  (authorizer ↔ gateway)
 * Chaining these, the gateway `(requestId)` + its `Status:` resolve to the business
 * correlationID, and the authorizer lines resolve in via the trace id.
 */
export function apiflcHttpOutcomes(logs: ParsedLog[]): string {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) {
      const next = parent.get(x)!;
      parent.set(x, r);
      x = next;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    parent.set(find(a), find(b));
  };

  // Every identifier a single log record carries, namespaced by kind so distinct
  // id spaces never collide.
  const idsOf = (raw: string): string[] => {
    const ids = new Set<string>();
    const corr = raw.match(/(?:correlationID:\s*|X-Correlation-ID\s*[=:]\s*)([A-Za-z0-9._-]+)/i)?.[1];
    if (corr) ids.add(`corr:${corr}`);
    // Gateway execution lines are prefixed "(<gatewayRequestId>)".
    const paren = raw.match(/^\s*\(([0-9a-f][0-9a-f-]{7,})\)/i)?.[1];
    if (paren) ids.add(`req:${paren.toLowerCase()}`);
    // Lambda requestId echoed in the gateway response headers / END|REPORT lines.
    for (const m of raw.matchAll(/(?:x-amzn-RequestId\s*=\s*|RequestId:\s*)([0-9a-f-]{16,})/gi)) {
      ids.add(`req:${m[1]!.toLowerCase()}`);
    }
    // Handler / authorizer line: "<ts> <lambdaRequestId> INFO ..." (2nd token, a uuid).
    const lead = raw.match(/^\S+\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)?.[1];
    if (lead) ids.add(`req:${lead.toLowerCase()}`);
    // X-Ray trace id — ties the authorizer log to the gateway log.
    const trace = raw.match(/(1-[0-9a-f]{8}-[0-9a-f]{24})/i)?.[1];
    if (trace) ids.add(`trace:${trace.toLowerCase()}`);
    return [...ids];
  };

  // Pass 1: union every record's ids; remember each record's ids + any HTTP status.
  const perLog: Array<{ ids: string[]; status?: string }> = [];
  for (const l of logs) {
    const ids = idsOf(l.raw);
    const status =
      l.raw.match(/received response\.\s*status:\s*(\d{3})/i)?.[1] ??
      l.raw.match(/method completed with status:\s*(\d{3})/i)?.[1];
    perLog.push({ ids, status });
    for (let i = 1; i < ids.length; i++) union(ids[0]!, ids[i]!);
  }

  // Pass 2: per connected component (final root) collect the business correlationID
  // and any HTTP status seen anywhere in that component.
  const corrByRoot = new Map<string, string>();
  const statusByRoot = new Map<string, string>();
  for (const { ids, status } of perLog) {
    if (!ids.length) continue;
    const root = find(ids[0]!);
    const corr = ids.find((x) => x.startsWith('corr:'));
    if (corr) corrByRoot.set(root, corr.slice('corr:'.length));
    if (status) statusByRoot.set(root, status);
  }

  const lines: string[] = [];
  for (const [root, status] of statusByRoot) {
    const corr = corrByRoot.get(root);
    lines.push(`- ${corr ? `correlationID=${corr}` : `gateway requestId=${root.replace(/^req:/, '')}`}: HTTP ${status}`);
  }
  if (!lines.length) return '';
  return [
    'API-GATEWAY HTTP OUTCOMES (joined across the handler, authorizer and execution logs; 2xx/3xx = success, 4xx/5xx = failure):',
    ...lines.sort(),
  ].join('\n');
}
