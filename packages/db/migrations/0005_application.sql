-- Multi-application support: tag ingestion agents and findings with the owning
-- application (e.g. 'scp', 'apiflc') so the dashboard can scope data per app.
ALTER TABLE agents   ADD COLUMN IF NOT EXISTS application TEXT;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS application TEXT;

-- Existing agents predate multi-app and were all SCP transactions.
UPDATE agents SET application = 'scp' WHERE application IS NULL;

CREATE INDEX IF NOT EXISTS idx_findings_application ON findings (application);
CREATE INDEX IF NOT EXISTS idx_agents_application ON agents (application);
