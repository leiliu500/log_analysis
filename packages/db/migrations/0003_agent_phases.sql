-- Generalize the ingestion-agent lifecycle from the hardcoded REQUEST/ACK/RESPONSE
-- shape to an arbitrary, protocol-defined phase sequence (see @log/shared
-- TransactionProtocol). `status` is now a generic 'awaiting' | 'completed' |
-- 'failed' | 'error'; the phase an active agent awaits, the ordered phase list,
-- and per-phase timestamps are stored generically. The old per-phase columns
-- (request_ts/ack_ts/response_ts) are superseded by phase_ts.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS waiting_for TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS phases      JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS phase_ts    JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Backfill existing rows into the generic model (best-effort for the demo DB).
UPDATE agents SET phases = '["REQUEST","ACK","RESPONSE"]'::jsonb WHERE phases = '[]'::jsonb;
UPDATE agents
SET phase_ts = (
  '{}'::jsonb
  || CASE WHEN request_ts  IS NOT NULL THEN jsonb_build_object('REQUEST',  request_ts)  ELSE '{}'::jsonb END
  || CASE WHEN ack_ts      IS NOT NULL THEN jsonb_build_object('ACK',      ack_ts)      ELSE '{}'::jsonb END
  || CASE WHEN response_ts IS NOT NULL THEN jsonb_build_object('RESPONSE', response_ts) ELSE '{}'::jsonb END
)
WHERE phase_ts = '{}'::jsonb;

UPDATE agents SET status = 'awaiting',  waiting_for = 'ACK'      WHERE status = 'awaiting_ack';
UPDATE agents SET status = 'awaiting',  waiting_for = 'RESPONSE' WHERE status = 'awaiting_response';

ALTER TABLE agents DROP COLUMN IF EXISTS request_ts;
ALTER TABLE agents DROP COLUMN IF EXISTS ack_ts;
ALTER TABLE agents DROP COLUMN IF EXISTS response_ts;
