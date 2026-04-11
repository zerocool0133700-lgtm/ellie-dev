-- Thread abstraction layer — ELLIE-1374 Phase 1

-- Thread table
CREATE TABLE IF NOT EXISTS chat_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES chat_channels(id),
  name TEXT NOT NULL,
  routing_mode TEXT NOT NULL DEFAULT 'coordinated',
  direct_agent TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_threads_channel ON chat_threads(channel_id);

-- Thread participants
CREATE TABLE IF NOT EXISTS thread_participants (
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (thread_id, agent)
);

-- Unread tracking
CREATE TABLE IF NOT EXISTS thread_read_state (
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  last_read_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (thread_id, user_id)
);

-- Add thread_id to existing tables
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS thread_id UUID REFERENCES chat_threads(id);
CREATE INDEX IF NOT EXISTS idx_conversations_thread ON conversations(thread_id) WHERE thread_id IS NOT NULL;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_id UUID;
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id) WHERE thread_id IS NOT NULL;

-- Seed the default "General" thread for the ellie-chat channel
DO $$
DECLARE
  v_channel_id UUID;
  v_thread_id UUID;
BEGIN
  -- Find or create a channel row for ellie-chat
  SELECT id INTO v_channel_id FROM chat_channels WHERE slug = 'general' LIMIT 1;
  IF v_channel_id IS NULL THEN
    INSERT INTO chat_channels (name, slug, context_mode, sort_order)
    VALUES ('General', 'general', 'conversation', 0)
    RETURNING id INTO v_channel_id;
  END IF;

  -- Create default thread
  INSERT INTO chat_threads (channel_id, name, routing_mode, created_by)
  VALUES (v_channel_id, 'General', 'coordinated', 'system')
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_thread_id;

  -- If thread was created, add all agents as participants
  IF v_thread_id IS NOT NULL THEN
    INSERT INTO thread_participants (thread_id, agent) VALUES
      (v_thread_id, 'ellie'),
      (v_thread_id, 'james'),
      (v_thread_id, 'kate'),
      (v_thread_id, 'alan'),
      (v_thread_id, 'brian'),
      (v_thread_id, 'jason'),
      (v_thread_id, 'amy'),
      (v_thread_id, 'marcus')
    ON CONFLICT DO NOTHING;
  END IF;
END $$;
