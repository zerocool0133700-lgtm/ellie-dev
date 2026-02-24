-- ELLIE-195: Add user_id to messages for multi-user support
-- Nullable TEXT column — existing rows stay NULL, new rows populated by channel handlers

ALTER TABLE messages ADD COLUMN IF NOT EXISTS user_id TEXT;

-- Partial index for user-scoped queries
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id) WHERE user_id IS NOT NULL;

-- Composite index for the primary query pattern: getRecentMessages(channel, userId)
CREATE INDEX IF NOT EXISTS idx_messages_channel_user_id ON messages(channel, user_id);
