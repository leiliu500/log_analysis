-- Core schema for the log-analysis platform.
-- pgvector powers semantic retrieval for the scoped chatbot (requirement 7).

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Parsed logs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parsed_logs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source        TEXT NOT NULL,
  stream        TEXT NOT NULL,
  ts            BIGINT NOT NULL,               -- event time, epoch millis
  level         TEXT NOT NULL DEFAULT 'unknown',
  message       TEXT NOT NULL,
  fields        JSONB NOT NULL DEFAULT '{}'::jsonb,
  entities      JSONB NOT NULL DEFAULT '{}'::jsonb,
  fingerprint   TEXT NOT NULL,
  raw           TEXT NOT NULL,
  ingested_at   BIGINT NOT NULL,
  embedding     vector(1024)                   -- Titan v2 dims; nullable
);

CREATE INDEX IF NOT EXISTS idx_parsed_logs_ts ON parsed_logs (ts DESC);
CREATE INDEX IF NOT EXISTS idx_parsed_logs_source ON parsed_logs (source);
CREATE INDEX IF NOT EXISTS idx_parsed_logs_fingerprint ON parsed_logs (fingerprint);
CREATE INDEX IF NOT EXISTS idx_parsed_logs_fields ON parsed_logs USING GIN (fields);

-- ---------------------------------------------------------------------------
-- Findings (anomalies, correlations, inferences, reasoning, patterns)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS findings (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  kind            TEXT NOT NULL,
  severity        TEXT NOT NULL,
  title           TEXT NOT NULL,
  summary         TEXT NOT NULL,
  confidence      DOUBLE PRECISION NOT NULL DEFAULT 0,
  sources         TEXT[] NOT NULL DEFAULT '{}',
  fingerprint     TEXT NOT NULL,
  evidence        JSONB NOT NULL DEFAULT '[]'::jsonb,
  reasoning       JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  window_start    BIGINT NOT NULL,
  window_end      BIGINT NOT NULL,
  created_at      BIGINT NOT NULL,
  embedding       vector(1024)
);

CREATE INDEX IF NOT EXISTS idx_findings_created ON findings (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings (severity);
CREATE INDEX IF NOT EXISTS idx_findings_kind ON findings (kind);
CREATE INDEX IF NOT EXISTS idx_findings_fingerprint ON findings (fingerprint);

-- Approximate NN index for semantic retrieval (built once data exists).
CREATE INDEX IF NOT EXISTS idx_findings_embedding
  ON findings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ---------------------------------------------------------------------------
-- Alerts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alerts (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  finding_id  UUID NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  severity    TEXT NOT NULL,
  channel     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts (status);

-- ---------------------------------------------------------------------------
-- Chat sessions & messages (scoped conversational memory)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_sessions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title       TEXT,
  created_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id  UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages (session_id, created_at);

-- ---------------------------------------------------------------------------
-- Learned patterns (the "learning" capability persists baselines here)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS learned_patterns (
  fingerprint   TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  sample        TEXT NOT NULL,
  occurrences   BIGINT NOT NULL DEFAULT 0,
  ewma_rate     DOUBLE PRECISION NOT NULL DEFAULT 0,  -- events/min baseline
  ewma_variance DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_seen     BIGINT NOT NULL,
  first_seen    BIGINT NOT NULL,
  is_known_good BOOLEAN NOT NULL DEFAULT FALSE
);
