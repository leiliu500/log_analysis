-- Stateful, long-lived ingestion agents. One row per correlation id (request
-- messageId). An agent is spawned on REQUEST and stays `active` while it waits
-- for ACK/RESPONSE; it closes (inactive) on ACK-failure/error, RESPONSE, or
-- timeout. Powers the Dashboard's active-agent cards + agent history.
CREATE TABLE IF NOT EXISTS agents (
  message_id   TEXT PRIMARY KEY,
  status       TEXT NOT NULL,   -- awaiting_ack | awaiting_response | completed | failed | error
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  source       TEXT,
  log_group    TEXT,
  request_ts   BIGINT,
  ack_ts       BIGINT,
  response_ts  BIGINT,
  ack_code     TEXT,
  severity     TEXT,
  detail       TEXT,
  spawned_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  closed_at    BIGINT
);

CREATE INDEX IF NOT EXISTS idx_agents_active ON agents (active, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_closed ON agents (closed_at DESC);
