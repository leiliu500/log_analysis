-- Per-application breakdown of each scheduled-ingestion run, so the dashboard's
-- Schedule tab can be scoped to a selected application (scp / apiflc / ...).
ALTER TABLE poller_runs ADD COLUMN IF NOT EXISTS by_application JSONB NOT NULL DEFAULT '{}'::jsonb;
