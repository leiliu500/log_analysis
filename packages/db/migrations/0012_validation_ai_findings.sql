-- The validation AI agent's output, kept in its OWN columns and never merged into the
-- deterministic `delta`. `ai_findings` holds only claims that survived deterministic
-- re-verification (every cited log id real, every predicate re-executed true);
-- `ai_rejected` counts the ones the admission gate discarded, so the model's
-- hallucination rate is a queryable production number rather than an assumption;
-- `ai_reviewed_at` marks the transactions that were residual enough to be reviewed at all.
ALTER TABLE validation_agents ADD COLUMN IF NOT EXISTS ai_findings    JSONB NOT NULL DEFAULT '[]';
ALTER TABLE validation_agents ADD COLUMN IF NOT EXISTS ai_rejected    INTEGER;
ALTER TABLE validation_agents ADD COLUMN IF NOT EXISTS ai_reviewed_at BIGINT;
