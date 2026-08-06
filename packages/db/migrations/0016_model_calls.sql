-- Per-invocation telemetry for every model call the platform makes.
--
-- Nothing recorded this before: the dashboard could show what the agents DECIDED but not
-- what it cost to decide it — which model answered, how long it took, how many tokens it
-- burned, or whether it failed. Those are the numbers that tell you the AI stages are
-- degrading (latency creeping, error rate rising, a truncation-prone token profile)
-- BEFORE the symptom reaches a verdict.
--
-- `latency_ms` and the token counts come from the Bedrock Converse response itself
-- (`metrics.latencyMs`, `usage.*`), so they are the provider's own measurement rather than
-- a wall-clock guess that includes our own overhead. `wall_ms` is measured here and kept
-- alongside precisely so the gap between them is visible.
--
-- Rows are pruned to a bounded recent history — this is an operational metric stream, not
-- an audit log, and an unbounded table on a t4g.medium is its own outage.
CREATE TABLE IF NOT EXISTS model_calls (
  id            TEXT PRIMARY KEY,
  ts            BIGINT NOT NULL,
  -- Which pipeline stage asked: ingest-transition | validation-review | analysis-reason
  -- | assistant-qa | simulate | supervisor | embed. Lets latency and failure be attributed
  -- to a stage rather than averaged into one meaningless platform-wide number.
  stage         TEXT   NOT NULL,
  model         TEXT   NOT NULL,
  application   TEXT,
  ok            BOOLEAN NOT NULL DEFAULT TRUE,
  -- Provider-reported latency; NULL when the call failed before returning metrics.
  latency_ms    INTEGER,
  -- Our own wall clock around the call, always present, including retries and transport.
  wall_ms       INTEGER NOT NULL DEFAULT 0,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  -- The reply's own length, so truncation pressure is visible: a reply that repeatedly
  -- lands at the token ceiling is the signature that produced unparseable validation JSON.
  reply_chars   INTEGER,
  stop_reason   TEXT,
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_model_calls_ts    ON model_calls (ts DESC);
CREATE INDEX IF NOT EXISTS idx_model_calls_stage ON model_calls (stage, ts DESC);

-- Per-stage wall-clock breakdown of one poll, so a slow poll can be attributed to a phase
-- (parse / correlate / agents / analyze / persist) instead of only showing a total. Also
-- carries the fast-path vs reasoned split, which was computed but never persisted — the
-- number that shows whether the model is back on the ingestion critical path.
ALTER TABLE poller_runs ADD COLUMN IF NOT EXISTS stages JSONB NOT NULL DEFAULT '{}'::jsonb;
