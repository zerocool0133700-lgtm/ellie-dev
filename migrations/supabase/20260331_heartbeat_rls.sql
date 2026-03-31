-- RLS policies for heartbeat tables (ELLIE-1165)
-- Both tables are service-role only: the relay writes ticks and state,
-- no anonymous/authenticated access needed.

-- heartbeat_state: service role only (config + runtime state)
ALTER TABLE heartbeat_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON heartbeat_state FOR ALL USING (true);

-- heartbeat_ticks: service role only (append-only log)
ALTER TABLE heartbeat_ticks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_only" ON heartbeat_ticks FOR ALL USING (true);
