-- A completed transaction can still have associated analysis findings (anomaly /
-- correlation), e.g. a high-latency anomaly on a 200 response. Record them on the
-- validation agent so a clean completion is distinguished from one with quality
-- issues (result 'completed_with_issues' when a high/critical one is present),
-- instead of the finding being silently ignored.
ALTER TABLE validation_agents ADD COLUMN IF NOT EXISTS quality_findings     JSONB NOT NULL DEFAULT '[]';
ALTER TABLE validation_agents ADD COLUMN IF NOT EXISTS max_quality_severity TEXT;
