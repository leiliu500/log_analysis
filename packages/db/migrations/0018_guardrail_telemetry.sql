-- Which Bedrock Guardrail policies fired on each model call.
--
-- Numbered 0018, skipping 0017: an in-flight causal-graph branch already claims
-- 0017_causal_graph.sql. Two files sharing a number would still both apply (the runner
-- sorts by filename and tracks each in _migrations), but the apply ORDER between them
-- would depend on the rest of the name — not something to leave to chance in a schema
-- history that is read as a sequence.
--
-- A guardrail intervention is not an error, and that is exactly why it needs its own
-- column. The call succeeded, was billed, and returned normal latency and token counts,
-- so `ok` stays TRUE and nothing in the existing shape distinguishes "the model answered"
-- from "the policy stopped it". Without this, a guardrail misfiring on routine log
-- analysis looks identical to healthy traffic on the dashboard, and the first signal is a
-- user saying the assistant stopped answering.
--
-- Stores POLICY NAMES ONLY (e.g. 'content:PROMPT_ATTACK', 'pii:AWS_SECRET_KEY') — never
-- the matched text. The matched span is by definition the secret or the injection payload
-- the guardrail just suppressed; copying it here would relocate it into a table the
-- telemetry dashboard renders.
ALTER TABLE model_calls ADD COLUMN IF NOT EXISTS guardrail_policies TEXT[];

-- Partial: interventions are meant to be RARE, so indexing only the rows that have one
-- keeps this a small index over the interesting minority rather than a mostly-NULL index
-- the size of the table.
CREATE INDEX IF NOT EXISTS idx_model_calls_guardrail
  ON model_calls (ts DESC)
  WHERE guardrail_policies IS NOT NULL;
