-- Validation agents — an autonomous 1:1 shadow of the ingestion `agents`, keyed
-- by the same correlation id (message_id). Each row records whether the regular
-- agent's lifecycle invariant holds: a NON-completed closed agent must have a
-- finding `tx:<message_id>` at the level its close reason implies; a completed
-- agent must have none. Produced by a SEPARATE validation poller that only reads
-- `agents` + `findings` and writes here, so it never touches the ingest path.
-- Powers the /validation page's active-validation cards + validation history.
CREATE TABLE IF NOT EXISTS validation_agents (
  message_id        TEXT PRIMARY KEY,
  application       TEXT,
  agent_status      TEXT NOT NULL,               -- mirrored regular-agent status
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  result            TEXT NOT NULL DEFAULT 'pending', -- pending | success | failure
  expected_finding  BOOLEAN NOT NULL DEFAULT FALSE,
  expected_severity TEXT,
  actual_finding    BOOLEAN NOT NULL DEFAULT FALSE,
  actual_severity   TEXT,
  delta             JSONB NOT NULL DEFAULT '[]',
  phases            JSONB NOT NULL DEFAULT '[]',
  phase_ts          JSONB NOT NULL DEFAULT '{}',
  detail            TEXT,
  spawned_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL,
  closed_at         BIGINT
);

CREATE INDEX IF NOT EXISTS idx_validation_active ON validation_agents (active, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_validation_closed ON validation_agents (closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_validation_application ON validation_agents (application);
CREATE INDEX IF NOT EXISTS idx_validation_result ON validation_agents (result);
