import { makeHttpReconciler } from '@log/shared';

/**
 * apiflc system-of-record reconciliation. Queries the downstream Data Services record
 * for a correlationID — did the API call's business effect actually land? — independent
 * of the gateway/handler logs the validator otherwise relies on. Catches a call the
 * logs report as a clean 200 that the system of record shows never took effect.
 *
 * Env-configured (unset ⇒ DISABLED — always `unknown`):
 *   APIFLC_RECONCILE_URL     base URL of the Data Services status API
 *   APIFLC_RECONCILE_TOKEN   optional bearer token
 *
 * Expected response per correlationID: `{ settled|completed: boolean }` or
 * `{ status: 'COMPLETE' | 'FAILED' | ... }` (see defaultInterpret).
 */
export const apiflcReconcile = makeHttpReconciler({
  url: process.env.APIFLC_RECONCILE_URL,
  path: (id) => `/status/${encodeURIComponent(id)}`,
  headers: () => (process.env.APIFLC_RECONCILE_TOKEN ? { Authorization: `Bearer ${process.env.APIFLC_RECONCILE_TOKEN}` } : undefined),
});
