-- ELLIE-846: Agent Presence — synthetic presence derived from session state
--
-- Agents don't have WebSocket connections. Presence is updated by the relay
-- when agents are dispatched (busy) or complete work (idle).

CREATE TABLE IF NOT EXISTS agent_presence (
  agent_name TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'idle', 'busy', 'offline')),
  current_channel_id UUID REFERENCES chat_channels(id),
  current_activity TEXT,
  last_seen TIMESTAMPTZ DEFAULT NOW()
);

-- Seed all agents as idle (relay sets to online on startup)
INSERT INTO agent_presence (agent_name, status)
VALUES
  ('general', 'idle'),
  ('dev', 'idle'),
  ('research', 'idle'),
  ('content', 'idle'),
  ('critic', 'idle'),
  ('strategy', 'idle'),
  ('ops', 'idle')
ON CONFLICT DO NOTHING;
