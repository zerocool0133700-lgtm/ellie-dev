-- Message reactions for Ellie Chat — ELLIE-637
-- Tracks emoji reactions per message per user.

CREATE TABLE IF NOT EXISTS message_reactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT 'system-dashboard',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (message_id, emoji, user_id)
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_message_id
  ON message_reactions(message_id);

-- Enable RLS
ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;

-- Allow all access for service role
CREATE POLICY "Service role full access" ON message_reactions
  FOR ALL USING (true);
