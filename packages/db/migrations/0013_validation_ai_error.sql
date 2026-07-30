-- Why an AI review could not be completed (model error, throttling, a reply too truncated
-- to recover claims from). Held separately from ai_findings because "the agent looked and
-- found nothing" and "the agent never answered" must never be indistinguishable — a failed
-- review rendering as a clean one is a false negative dressed up as reassurance.
-- A row with ai_error set and no ai_reviewed_at was NOT reviewed and will be retried.
ALTER TABLE validation_agents ADD COLUMN IF NOT EXISTS ai_error TEXT;
