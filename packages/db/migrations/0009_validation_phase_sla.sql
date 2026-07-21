-- Per-application validation now checks transaction phase-completeness and an
-- app-specific response SLA (scp: 30 min after ACK; apiflc: 2 min after REQUEST),
-- in addition to the finding/level invariant. Record the extra dimensions on the
-- validation agent so the /validation page can show them.
ALTER TABLE validation_agents ADD COLUMN IF NOT EXISTS missing_phases     JSONB   NOT NULL DEFAULT '[]';
ALTER TABLE validation_agents ADD COLUMN IF NOT EXISTS sla_breached       BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE validation_agents ADD COLUMN IF NOT EXISTS sla_budget_minutes INTEGER;
ALTER TABLE validation_agents ADD COLUMN IF NOT EXISTS sla_from_phase     TEXT;
ALTER TABLE validation_agents ADD COLUMN IF NOT EXISTS response_latency_ms BIGINT;
