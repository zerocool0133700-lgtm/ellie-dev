-- ELLIE-856: Message Threads — parent/child threading

ALTER TABLE messages ADD COLUMN IF NOT EXISTS parent_message_id UUID REFERENCES messages(id);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_count INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_messages_parent
  ON messages(parent_message_id) WHERE parent_message_id IS NOT NULL;
