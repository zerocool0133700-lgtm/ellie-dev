-- ELLIE-849: Message Mentions — @mention tracking and routing

CREATE TABLE IF NOT EXISTS message_mentions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  mentioned_type TEXT NOT NULL CHECK (mentioned_type IN ('agent', 'user', 'here', 'channel')),
  mentioned_id TEXT,  -- agent name or user ID; null for @here/@channel
  channel_id UUID REFERENCES chat_channels(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_message_mentions_message ON message_mentions(message_id);
CREATE INDEX IF NOT EXISTS idx_message_mentions_target ON message_mentions(mentioned_type, mentioned_id);
CREATE INDEX IF NOT EXISTS idx_message_mentions_channel ON message_mentions(channel_id);
