-- Rename the primary "findings" records to "anomalies" throughout the schema.
-- "finding" was the umbrella term; the product now uses "anomaly" everywhere (UI +
-- data). Runs once (forward-only runner). Wrapped in a transaction so a partial
-- failure rolls back cleanly, and guarded with IF EXISTS for re-run safety.
BEGIN;

-- Primary table + its indexes.
ALTER TABLE IF EXISTS findings RENAME TO anomalies;
ALTER INDEX IF EXISTS idx_findings_created     RENAME TO idx_anomalies_created;
ALTER INDEX IF EXISTS idx_findings_severity    RENAME TO idx_anomalies_severity;
ALTER INDEX IF EXISTS idx_findings_kind        RENAME TO idx_anomalies_kind;
ALTER INDEX IF EXISTS idx_findings_fingerprint RENAME TO idx_anomalies_fingerprint;
ALTER INDEX IF EXISTS idx_findings_embedding   RENAME TO idx_anomalies_embedding;

-- Transitional backward-compat: a `findings` view over `anomalies` so any in-flight
-- OLD task (API / validation Lambda not yet redeployed) keeps reading and writing
-- during the rollout. Single-table view ⇒ auto-updatable (INSERT/UPDATE/DELETE work).
-- Harmless to leave; a later migration may drop it once every reader is on the new name.
CREATE OR REPLACE VIEW findings AS SELECT * FROM anomalies;

-- Foreign-key column on alerts (the table's FK now targets `anomalies` automatically).
ALTER TABLE IF EXISTS alerts RENAME COLUMN finding_id TO anomaly_id;

-- Scheduled-run per-run count.
ALTER TABLE IF EXISTS poller_runs RENAME COLUMN findings TO anomalies;

-- Validation shadow columns: "finding" here means "an anomaly was expected/actual".
ALTER TABLE IF EXISTS validation_agents RENAME COLUMN expected_finding TO expected_anomaly;
ALTER TABLE IF EXISTS validation_agents RENAME COLUMN actual_finding   TO actual_anomaly;
ALTER TABLE IF EXISTS validation_agents RENAME COLUMN quality_findings TO quality_anomalies;

COMMIT;
