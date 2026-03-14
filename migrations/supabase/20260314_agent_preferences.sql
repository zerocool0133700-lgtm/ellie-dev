-- Agent preferences — ELLIE-639
-- Key-value store for agent behavior settings (emoji, tone, etc.)

CREATE TABLE IF NOT EXISTS agent_preferences (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Default emoji preferences
INSERT INTO agent_preferences (key, value) VALUES
  ('emoji_enabled', 'true'),
  ('emoji_style', '"minimal"')
ON CONFLICT (key) DO NOTHING;

-- Enable RLS
ALTER TABLE agent_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON agent_preferences
  FOR ALL USING (true);
