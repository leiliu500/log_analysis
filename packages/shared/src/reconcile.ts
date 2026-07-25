import type { ParsedLog } from './logs.js';
import type { ReconciliationResult } from './application.js';

/**
 * A production HTTP reconciliation adapter for `ApplicationValidation.reconcile`.
 *
 * Reconciliation is the ONE validation signal that does not come from the logs — it
 * asks the downstream **system of record** (did the payment actually settle? did the
 * business effect land?) and compares that to what the agent recorded. Because the
 * agent and the validator otherwise share the logs as their only evidence, this is the
 * only way to catch a false negative that a missing/wrong log line hides from both.
 *
 * Design invariants:
 *  - **Safe by default.** No `url` configured ⇒ reconciliation is DISABLED and always
 *    returns `unknown`, so it never affects a verdict until you point it at a real SoR.
 *  - **Only positive evidence speaks.** Any error, timeout, 404, or inconclusive
 *    response ⇒ `unknown` (no delta). Only a definitive settled/failed from the SoR
 *    produces a concrete outcome, which the engine turns into a `system-of-record
 *    mismatch` delta iff it contradicts the agent.
 *  - **Bounded.** Per-request timeout; never blocks the validation pass.
 */
export interface HttpReconcileConfig {
  /** Base URL of the system-of-record status endpoint. Absent ⇒ DISABLED (always `unknown`). */
  url?: string;
  /** Path for a given transaction id, appended to `url`. Default: `/<id>`. */
  path?(messageId: string): string;
  /** Extra request headers (e.g. `Authorization`). */
  headers?(): Record<string, string> | undefined;
  /** Map the SoR HTTP response to an outcome. Default: {@link defaultInterpret}. */
  interpret?(body: unknown, status: number): ReconciliationResult;
  /** Per-request timeout in ms. Default 4000. */
  timeoutMs?: number;
  /** Injected fetch (for tests). Default: global `fetch`. */
  fetchImpl?: typeof fetch;
}

type ReconcileInput = { messageId: string; agentStatus: string; relatedLogs: readonly ParsedLog[] };

/**
 * Default mapping of a system-of-record response to an outcome. Recognizes a boolean
 * `settled`/`completed` flag or a `status`/`state` string with common settlement/reject
 * vocabulary. Anything else (including a 404 "no record") is `unknown`.
 */
export function defaultInterpret(body: unknown, status: number): ReconciliationResult {
  if (status === 404) return { outcome: 'unknown', detail: 'system of record has no record for this id' };
  if (status >= 500) return { outcome: 'unknown', detail: `system of record error ${status}` };
  const o = (body ?? {}) as Record<string, unknown>;
  const flag = o.settled ?? o.completed;
  const s = String(o.status ?? o.state ?? '').toLowerCase();
  if (flag === true || /\b(settled|complete[d]?|success(ful)?|posted|cleared|accepted)\b/.test(s)) {
    return { outcome: 'completed', detail: `record: ${String(o.status ?? o.state ?? 'settled')}` };
  }
  if (flag === false || /\b(fail(ed)?|reject(ed)?|return(ed)?|cancel(l)?ed|error|unsettled)\b/.test(s)) {
    return { outcome: 'failed', detail: `record: ${String(o.status ?? o.state ?? 'not settled')}` };
  }
  return { outcome: 'unknown', detail: 'record inconclusive' };
}

/** Build a `reconcile` function that queries an external system of record over HTTP. */
export function makeHttpReconciler(cfg: HttpReconcileConfig): (input: ReconcileInput) => Promise<ReconciliationResult> {
  const interpret = cfg.interpret ?? defaultInterpret;
  const doFetch = cfg.fetchImpl ?? fetch;
  return async ({ messageId }) => {
    if (!cfg.url) return { outcome: 'unknown' }; // disabled — no external source configured
    const base = cfg.url.replace(/\/+$/, '');
    const rawPath = cfg.path ? cfg.path(messageId) : `/${encodeURIComponent(messageId)}`;
    const url = `${base}${rawPath.startsWith('/') ? '' : '/'}${rawPath}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 4000);
    try {
      const res = await doFetch(url, { headers: { Accept: 'application/json', ...(cfg.headers?.() ?? {}) }, signal: ctrl.signal });
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      return interpret(body, res.status);
    } catch (err) {
      // Network error / timeout / abort — reconciliation is best-effort and must never
      // block or fail a validation pass, so this is simply "no signal".
      return { outcome: 'unknown', detail: `system of record unavailable: ${(err as Error).message}` };
    } finally {
      clearTimeout(timer);
    }
  };
}
