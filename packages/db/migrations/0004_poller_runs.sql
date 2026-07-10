-- Scheduled-ingestion run history. One row per analyzeAllSources invocation
-- (the EventBridge poller every ~5 min, or an on-demand "Analyze now"). Powers
-- the dashboard's Schedule tab. Bounded to the most recent rows on insert.
CREATE TABLE IF NOT EXISTS poller_runs (
  id             TEXT PRIMARY KEY,
  ran_at         BIGINT NOT NULL,
  trigger        TEXT   NOT NULL,               -- schedule | manual
  window_minutes INT    NOT NULL DEFAULT 5,
  duration_ms    INT    NOT NULL DEFAULT 0,
  by_source      JSONB  NOT NULL DEFAULT '{}'::jsonb,
  agents         JSONB  NOT NULL DEFAULT '{}'::jsonb,
  findings       INT    NOT NULL DEFAULT 0,
  pruned         INT    NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_poller_runs_ran_at ON poller_runs (ran_at DESC);
