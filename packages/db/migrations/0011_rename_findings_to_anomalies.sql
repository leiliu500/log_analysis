-- Rename the primary "findings" records to "anomalies" throughout the schema.
-- NOTE: NO explicit BEGIN/COMMIT — the migration runner executes each file via
-- postgres.js `sql.unsafe()`, which REJECTS explicit transaction control
-- (UNSAFE_TRANSACTION) and, worse, poisons the pooled connection. A multi-statement
-- simple query already runs in one implicit transaction. Every statement is guarded
-- (IF EXISTS / information_schema checks) so this is safe to (re)run against a
-- database in ANY partial state.

ALTER TABLE IF EXISTS findings RENAME TO anomalies;
ALTER INDEX IF EXISTS idx_findings_created     RENAME TO idx_anomalies_created;
ALTER INDEX IF EXISTS idx_findings_severity    RENAME TO idx_anomalies_severity;
ALTER INDEX IF EXISTS idx_findings_kind        RENAME TO idx_anomalies_kind;
ALTER INDEX IF EXISTS idx_findings_fingerprint RENAME TO idx_anomalies_fingerprint;
ALTER INDEX IF EXISTS idx_findings_embedding   RENAME TO idx_anomalies_embedding;

-- Transitional backward-compat view so any in-flight OLD task keeps reading/writing
-- during the rollout (single-table view ⇒ auto-updatable). Runs after the rename so
-- the `findings` name is free.
CREATE OR REPLACE VIEW findings AS SELECT * FROM anomalies;

-- Dependent columns — guarded so a re-run against already-renamed columns is a no-op.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'alerts' AND column_name = 'finding_id') THEN
    ALTER TABLE alerts RENAME COLUMN finding_id TO anomaly_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'poller_runs' AND column_name = 'findings') THEN
    ALTER TABLE poller_runs RENAME COLUMN findings TO anomalies;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'validation_agents' AND column_name = 'expected_finding') THEN
    ALTER TABLE validation_agents RENAME COLUMN expected_finding TO expected_anomaly;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'validation_agents' AND column_name = 'actual_finding') THEN
    ALTER TABLE validation_agents RENAME COLUMN actual_finding TO actual_anomaly;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'validation_agents' AND column_name = 'quality_findings') THEN
    ALTER TABLE validation_agents RENAME COLUMN quality_findings TO quality_anomalies;
  END IF;
END $$;
