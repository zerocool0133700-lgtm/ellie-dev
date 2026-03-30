CREATE TABLE IF NOT EXISTS routing_decisions (
  id TEXT PRIMARY KEY,
  session_id UUID,
  dispatch_envelope_id TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_message TEXT,
  agents_considered TEXT[],
  agent_chosen TEXT NOT NULL,
  confidence NUMERIC(3,2) NOT NULL,
  match_type TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  skills_loaded TEXT[]
);

CREATE INDEX IF NOT EXISTS idx_routing_decisions_session ON routing_decisions(session_id);
CREATE INDEX IF NOT EXISTS idx_routing_decisions_timestamp ON routing_decisions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_routing_decisions_confidence ON routing_decisions(confidence) WHERE confidence < 0.7;
