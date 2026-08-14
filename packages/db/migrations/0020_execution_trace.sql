-- Complete ingestion traces and their defensive integrity verdict.
ALTER TABLE poller_runs ADD COLUMN IF NOT EXISTS trace JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE poller_runs ADD COLUMN IF NOT EXISTS trace_validation JSONB NOT NULL DEFAULT
  jsonb_build_object(
    'status', 'failed', 'checkedAt', 0, 'checks', 0,
    'violations', jsonb_build_array(jsonb_build_object(
      'code', 'legacy_trace', 'message', 'Execution predates complete tracing.'
    ))
  );
