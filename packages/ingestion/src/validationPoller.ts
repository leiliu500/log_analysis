/**
 * Scheduled validation Lambda. EventBridge invokes this on its OWN schedule, in
 * parallel with the ingest poller. It runs the autonomous validation lifecycle:
 * for every regular ingestion agent it confirms — per that application's own
 * `validation.md` rules (phases + response SLA + finding/level invariant) — that
 * the transaction is consistent, and persists a success/failure per transaction.
 *
 * It is deliberately isolated from the ingest path: it only READS `agents` +
 * `findings` and WRITES `validation_agents`, so it can never mutate or block
 * regular ingestion. The application registry is injected here (same one the
 * ingest poller uses) so each agent is validated against its owning app's rules.
 */
import { validateAgents, type ValidationRunResult } from '@log/analysis';
import { applicationRegistry } from '@log/applications';

/** EventBridge entry point — the always-on autonomous validation poll. */
export async function validationPollerHandler(
  event: { historyTtlMs?: number } = {},
): Promise<ValidationRunResult> {
  return validateAgents(applicationRegistry, event);
}
