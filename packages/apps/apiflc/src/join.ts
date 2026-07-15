import type { ParsedLog } from '@log/shared';
import { coalesceEntries } from '@log/shared';

/**
 * Joining apiflc's three log groups into one call.
 *
 * A single API call is logged across the handler, the authorizer and the
 * API-Gateway execution log under DIFFERENT ids. The links, all verified against
 * the real groups:
 *   handler.correlationID   == gateway `X-Correlation-ID`      (handler ↔ gateway)
 *   handler.lambdaRequestId == gateway `x-amzn-RequestId`      (handler ↔ gateway)
 *   authorizer.xrayTraceId  == gateway `X-Amzn-Trace-Id` Root  (authorizer ↔ gateway)
 * There is NO direct handler ↔ authorizer link — the authorizer log carries no
 * correlationID, and its lambdaRequestId appears nowhere in the other groups. It
 * joins only through the gateway's trace id.
 *
 * The join runs over COALESCED ENTRIES, not raw records, and must: the authorizer's
 * `REPORT RequestId: <id>` and `XRAY TraceId: 1-...` are separate CloudWatch events,
 * so per-record no line carries both the request id and the trace id and the
 * authorizer would never connect to anything.
 */

/** Every identifier one log entry carries, namespaced by kind so id spaces never collide. */
export function apiflcIdsOf(raw: string): string[] {
  const ids = new Set<string>();
  const corr = raw.match(/(?:correlationID:\s*|X-Correlation-ID\s*[=:]\s*)([A-Za-z0-9._-]+)/i)?.[1];
  if (corr) ids.add(`corr:${corr}`);
  // Gateway execution lines are prefixed "(<gatewayRequestId>)".
  const paren = raw.match(/^\s*\(([0-9a-f][0-9a-f-]{7,})\)/i)?.[1];
  if (paren) ids.add(`req:${paren.toLowerCase()}`);
  // Lambda requestId echoed in the gateway response headers / START|END|REPORT lines.
  for (const m of raw.matchAll(/(?:x-amzn-RequestId\s*=\s*|RequestId\s*:\s*)([0-9a-f-]{16,})/gi)) {
    ids.add(`req:${m[1]!.toLowerCase()}`);
  }
  // Handler / authorizer line: "<ts> <lambdaRequestId> INFO ..." (2nd token, a uuid).
  const lead = raw.match(/^\S+\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)?.[1];
  if (lead) ids.add(`req:${lead.toLowerCase()}`);
  // X-Ray trace id — the ONLY thing tying the authorizer log to the gateway log.
  const trace = raw.match(/(1-[0-9a-f]{8}-[0-9a-f]{24})/i)?.[1];
  if (trace) ids.add(`trace:${trace.toLowerCase()}`);
  return [...ids];
}

export interface ApiflcJoin {
  /** Representative of an id's connected component (all ids of one call). */
  find: (x: string) => string;
  /** Every id seen across the input. */
  present: Set<string>;
  /** The coalesced entries, and the ids each one carries (same order). */
  entries: Array<{ raw: string; lines: ParsedLog[]; head: ParsedLog; ids: string[] }>;
}

/** Union every id that co-occurs in one entry, connecting the three groups' id spaces. */
export function apiflcJoin(logs: readonly ParsedLog[]): ApiflcJoin {
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

  const present = new Set<string>();
  const entries = coalesceEntries(logs).map((e) => {
    const ids = apiflcIdsOf(e.raw);
    for (const id of ids) present.add(id);
    for (let i = 1; i < ids.length; i++) union(ids[0]!, ids[i]!);
    return { raw: e.raw, lines: e.lines, head: e.head, ids };
  });

  return { find, present, entries };
}

/**
 * Every log record belonging to the same call as `id` — across all three groups.
 * Give it a business correlationID (1234), a gateway/lambda requestId or an X-Ray
 * trace id; it resolves the rest through the shared identifiers above. Returns []
 * when the id joins to nothing in the window.
 */
export function apiflcRelatedLogs(id: string, logs: readonly ParsedLog[]): ParsedLog[] {
  const { find, present, entries } = apiflcJoin(logs);
  const seeds = [`corr:${id}`, `req:${id.toLowerCase()}`, `trace:${id.toLowerCase()}`].filter((s) => present.has(s));
  if (!seeds.length) return [];
  const roots = new Set(seeds.map(find));
  const out: ParsedLog[] = [];
  for (const e of entries) if (e.ids.some((x) => roots.has(find(x)))) out.push(...e.lines);
  return out;
}
