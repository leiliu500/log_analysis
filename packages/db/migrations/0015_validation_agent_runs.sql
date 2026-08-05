-- The per-application VALIDATION AI AGENT as a LIFECYCLE rather than a static roster.
-- One row per (validation run x application): inserted when that app's agent starts
-- reviewing, closed with its counts when the run finishes. `finished_at IS NULL` means
-- the agent is ACTIVE right now, which is what the dashboard renders — so an agent
-- appears when validation is triggered and disappears when it is done, instead of always
-- being listed whether or not it is doing anything.
--
-- A row is only created when the agent actually has residual transactions to review, so
-- an idle poll spawns nothing.
CREATE TABLE IF NOT EXISTS validation_agent_runs (
  id           TEXT PRIMARY KEY,
  run_id       TEXT   NOT NULL,          -- groups the applications of one validation pass
  application  TEXT   NOT NULL,
  trigger      TEXT   NOT NULL,          -- schedule | manual
  started_at   BIGINT NOT NULL,
  finished_at  BIGINT,                   -- NULL = still running (i.e. ACTIVE)
  queued       INT    NOT NULL DEFAULT 0,-- residual transactions handed to this agent
  reviewed     INT    NOT NULL DEFAULT 0,
  suspected    INT    NOT NULL DEFAULT 0,
  discarded    INT    NOT NULL DEFAULT 0,
  failed       INT    NOT NULL DEFAULT 0,
  detail       TEXT
);

CREATE INDEX IF NOT EXISTS idx_validation_agent_runs_active
  ON validation_agent_runs (finished_at, started_at DESC);
