-- WALL-CLOCK time the engine first observed a transaction, as distinct from spawned_at,
-- which is DATA time (the initiating log line's own timestamp).
--
-- The inactivity timeout compared wall-clock `now` against spawned_at/phase_ts, i.e. it
-- mixed two clocks. Any transaction whose logs were already older than its timeout when
-- ingested — a simulation, a back-fill, a catch-up after the poller was down, or plain
-- delivery latency — was therefore closed as "timed out" by the first poll that saw it
-- and never existed as an active agent. The timeout now also requires that the engine
-- actually watched the transaction for a full timeout window, which needs this column.
--
-- Backfilled to spawned_at for existing rows: for agents already ingested from live
-- traffic the two clocks are close, so this preserves their current timeout behaviour.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS first_seen_at BIGINT;
UPDATE agents SET first_seen_at = spawned_at WHERE first_seen_at IS NULL;
