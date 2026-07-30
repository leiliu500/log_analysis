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
  /** The business correlationID anchoring a component (undefined when it carries none). */
  corrForRoot: (x: string) => string | undefined;
}

/**
 * Union every id that co-occurs in one entry, connecting the three groups' id spaces —
 * with ONE hard rule: the business `correlationID` is authoritative and two DIFFERENT
 * correlationIDs are NEVER merged into one call. A gateway/lambda requestId or X-Ray
 * trace id is a weaker link; if the same requestId shows up under two business ids (a
 * reused/derived id, or corrupt data), the shared requestId must not entangle the two
 * distinct transactions. Without this, one bad line collapses every apiflc call into a
 * single blob and no agent can read its own HTTP status.
 */
/**
 * Per-window memoization of {@link buildApiflcJoin}.
 *
 * The join rebuilds a whole union-find over EVERY log in the window and re-coalesces the
 * entries, so it is O(window) with fresh Map allocations each call. That was affordable
 * while only the handful of transactions being reasoned about called it. It stopped being
 * affordable when the ingestion fast path started calling it once per apiflc transaction:
 * the cost became O(transactions x window) — 1,000 transactions over a 10,000-line window
 * is ten million line-scans and a thousand union-find rebuilds in a single poll.
 *
 * Every caller in a poll is handed the SAME window array, so keying on the array identity
 * collapses that back to O(window) once per poll. It is a WeakMap, so a window is
 * collected with the poll that made it.
 *
 * ASSUMPTION: a window array is treated as immutable once built (it is — the engine
 * assembles it, then only reads). The length check catches the one mutation that would
 * realistically happen, an append, so a grown array is rebuilt rather than served stale.
 */
const joinCache = new WeakMap<object, { size: number; join: ApiflcJoin }>();

export function apiflcJoin(logs: readonly ParsedLog[]): ApiflcJoin {
  const key = logs as unknown as object;
  const hit = joinCache.get(key);
  if (hit && hit.size === logs.length) return hit.join;
  const join = buildApiflcJoin(logs);
  joinCache.set(key, { size: logs.length, join });
  return join;
}

function buildApiflcJoin(logs: readonly ParsedLog[]): ApiflcJoin {
  const parent = new Map<string, string>();
  const corrOf = new Map<string, string>(); // component root -> its business correlationID
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
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const ca = corrOf.get(ra);
    const cb = corrOf.get(rb);
    if (ca !== undefined && cb !== undefined && ca !== cb) return; // never merge two business corrs
    parent.set(ra, rb);
    const c = cb ?? ca;
    if (c !== undefined) corrOf.set(rb, c);
  };

  const present = new Set<string>();
  const entries = coalesceEntries(logs).map((e) => {
    const ids = apiflcIdsOf(e.raw);
    for (const id of ids) {
      present.add(id);
      if (id.startsWith('corr:')) {
        const r = find(id);
        if (!corrOf.has(r)) corrOf.set(r, id.slice('corr:'.length));
      }
    }
    for (let i = 1; i < ids.length; i++) union(ids[0]!, ids[i]!);
    return { raw: e.raw, lines: e.lines, head: e.head, ids };
  });

  return { find, present, entries, corrForRoot: (x) => corrOf.get(find(x)) };
}

/**
 * Every log record belonging to the same call as `id` — across all three groups.
 * Give it a business correlationID (1234), a gateway/lambda requestId or an X-Ray
 * trace id; it resolves the rest through the shared identifiers above. Returns []
 * when the id joins to nothing in the window.
 *
 * When the call is anchored by a business correlationID, entries that name a DIFFERENT
 * correlationID are excluded — so a stray line that merely shares a requestId can never
 * pull a foreign transaction's HTTP status into this call.
 */
export function apiflcRelatedLogs(id: string, logs: readonly ParsedLog[]): ParsedLog[] {
  const { find, present, entries, corrForRoot } = apiflcJoin(logs);
  const seeds = [`corr:${id}`, `req:${id.toLowerCase()}`, `trace:${id.toLowerCase()}`].filter((s) => present.has(s));
  if (!seeds.length) return [];
  const roots = new Set(seeds.map(find));
  const anchorCorr = seeds.map((s) => corrForRoot(s)).find((c) => c !== undefined);
  const out: ParsedLog[] = [];
  for (const e of entries) {
    if (!e.ids.some((x) => roots.has(find(x)))) continue;
    // Corr-consistency: drop any entry that names a different business correlationID.
    const entryCorr = e.ids.find((x) => x.startsWith('corr:'))?.slice('corr:'.length);
    if (anchorCorr !== undefined && entryCorr !== undefined && entryCorr !== anchorCorr) continue;
    out.push(...e.lines);
  }
  return out;
}
