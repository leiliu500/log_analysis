-- Agent activity: one row per agent spawned during agentic ingestion. Powers the
-- Dashboard's "agent dynamics" view — which agent processed which request, the
-- request/ack/response timestamps, the outcome, and how long it took.
CREATE TABLE IF NOT EXISTS agent_activity (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  batch_id      UUID NOT NULL,                 -- the ingest/dispatch cycle
  agent_no      INT NOT NULL,                  -- sequence within the cycle
  kind          TEXT NOT NULL,                 -- transaction | error | correlation
  message_id    TEXT,                          -- correlation id (request messageId)
  status        TEXT NOT NULL,                 -- finding | clean | duplicate | error
  severity      TEXT,
  finding_id    UUID,
  source        TEXT,
  log_group     TEXT,
  present_types TEXT[] NOT NULL DEFAULT '{}',  -- REQUEST/ACK/RESPONSE seen
  request_ts    BIGINT,
  ack_ts        BIGINT,
  response_ts   BIGINT,
  ack_code      TEXT,
  detail        TEXT,                          -- reason / error / label
  started_at    BIGINT NOT NULL,
  finished_at   BIGINT NOT NULL,
  duration_ms   INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_agent_activity_started ON agent_activity (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_activity_batch ON agent_activity (batch_id);
CREATE INDEX IF NOT EXISTS idx_agent_activity_msgid ON agent_activity (message_id);
