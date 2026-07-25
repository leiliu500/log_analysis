import { makeHttpReconciler } from '@log/shared';

/**
 * SCP system-of-record reconciliation. Queries the SETTLEMENT status of a cashMessage
 * from the downstream ledger / FRB system of record, keyed by messageId — the only
 * validation signal that does NOT come from the same logs the ingestion agent and the
 * validator both read. It catches the shared blind spot: a transaction the logs call
 * `completed` that the ledger shows never settled (false negative), or vice-versa.
 *
 * Configured entirely by environment (unset ⇒ DISABLED — always `unknown`, never
 * affects a verdict):
 *   SCP_RECONCILE_URL     base URL of the settlement-status API
 *   SCP_RECONCILE_TOKEN   optional bearer token
 *
 * Expected response per messageId: `{ settled: boolean }` or
 * `{ status: 'SETTLED' | 'RETURNED' | 'REJECTED' | ... }` (see defaultInterpret).
 */
export const scpReconcile = makeHttpReconciler({
  url: process.env.SCP_RECONCILE_URL,
  path: (id) => `/settlement/${encodeURIComponent(id)}`,
  headers: () => (process.env.SCP_RECONCILE_TOKEN ? { Authorization: `Bearer ${process.env.SCP_RECONCILE_TOKEN}` } : undefined),
});
