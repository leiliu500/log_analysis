/**
 * The CloudWatch log groups the apiflc application owns. The API-Gateway
 * execution-log group is matched by prefix (its full name carries a trailing
 * "/<stage>" path). These are external/real groups (not created by our
 * Terraform) — the poller reads them via CLOUDWATCH_LOG_GROUPS.
 */
export const APIFLC_LOG_GROUPS = [
  '/aws/lambda/adt-fca-d1-api_gateway_handler',
  '/aws/lambda/adt-fca-d1-api_gateway_authorizer',
  '/aws/lambda/adt-fca-d1-api_gateway_background',
  'API-Gateway-Execution-Logs_9ioz6z9om1/d1',
] as const;

export type ApiflcLogGroup = (typeof APIFLC_LOG_GROUPS)[number];

/**
 * Detect an apiflc target log group named in a message — an exact group name, or
 * a content-type keyword (handler / authorizer / background / gateway/execution).
 * Returns undefined when nothing matches (the simulator falls back to other apps).
 */
export function parseApiflcLogGroup(message: string): ApiflcLogGroup | undefined {
  for (const g of APIFLC_LOG_GROUPS) if (message.includes(g)) return g;
  const m = message.toLowerCase();
  if (/\bauthoriz/.test(m)) return '/aws/lambda/adt-fca-d1-api_gateway_authorizer';
  if (/\bbackground\b/.test(m)) return '/aws/lambda/adt-fca-d1-api_gateway_background';
  if (/\bexecution[-\s]?log|\bapi[-\s]?gateway[-\s]?exec/.test(m)) return 'API-Gateway-Execution-Logs_9ioz6z9om1/d1';
  if (/\bapiflc\b|\bapi[-\s_]?gateway\b|\badt-fca\b|\bfca\b/.test(m)) return '/aws/lambda/adt-fca-d1-api_gateway_handler';
  return undefined;
}

/**
 * Is this line a header that targets a specific apiflc log group? Recognizes a
 * "Simulate/Write ... log group: <group>" line where the group name is at the
 * end — so an in-content ARN/URI mention (e.g. ".../function:...authorizer/invocations")
 * is NOT mistaken for a header.
 */
function headerGroup(line: string): ApiflcLogGroup | undefined {
  const t = line.trim().replace(/[:\-–—]\s*$/, '').trim();
  for (const g of APIFLC_LOG_GROUPS) {
    if (t.endsWith(g)) {
      const prefix = t.slice(0, t.length - g.length);
      if (/\b(write|simulate|group|goup|target|to)\b/i.test(prefix)) return g;
    }
  }
  return undefined;
}

/**
 * Split a multi-group apiflc paste into per-log-group segments. The input labels
 * each block with a header line naming its target group (e.g. "Simulate Write to
 * apiflc cloudwatch log group: /aws/lambda/adt-fca-d1-api_gateway_handler"),
 * followed by that group's raw log lines. Returns one segment per labeled group;
 * [] when the paste has no group headers (single-group / default handling).
 */
export function splitApiflcByLogGroup(message: string): Array<{ group: string; samples: string }> {
  const lines = message.split(/\r?\n/);
  const segs: Array<{ group: ApiflcLogGroup; lines: string[] }> = [];
  let cur: { group: ApiflcLogGroup; lines: string[] } | undefined;
  for (const line of lines) {
    const g = headerGroup(line);
    if (g) {
      cur = { group: g, lines: [] };
      segs.push(cur);
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  return segs
    .map((s) => ({ group: s.group, samples: s.lines.join('\n').trim() }))
    .filter((s) => s.samples.length > 0);
}
