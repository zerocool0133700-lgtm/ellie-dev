-- ELLIE-51: Explicit conversation tracking with rolling summaries
-- Run against Supabase SQL editor AFTER existing schema is in place.
--
-- Changes the conversations model from "created after the fact" to
-- "created at message time" with status lifecycle and agent tracking.

-- ============================================================
-- ADD COLUMNS: status, agent, last_message_at
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS agent TEXT DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ;

-- Check constraint for status values
DO $$ BEGIN
  ALTER TABLE conversations ADD CONSTRAINT conversations_status_check
    CHECK (status IN ('active', 'closed', 'expired'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- ALTER: Make ended_at nullable (active conversations haven't ended)
-- ============================================================

ALTER TABLE conversations ALTER COLUMN ended_at DROP NOT NULL;
ALTER TABLE conversations ALTER COLUMN started_at SET DEFAULT NOW();

-- ============================================================
-- BACKFILL: Mark all existing conversations as closed
-- ============================================================

UPDATE conversations SET status = 'closed' WHERE status IS NULL OR status = 'active';
UPDATE conversations SET last_message_at = ended_at WHERE last_message_at IS NULL;

-- ============================================================
-- INDEXES: Fast active conversation lookup
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_conversations_channel_status ON conversations(channel, status);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at ON conversations(last_message_at DESC);

-- ============================================================
-- RPC: Get or create active conversation for a channel
-- ============================================================

CREATE OR REPLACE FUNCTION get_or_create_conversation(
  p_channel TEXT,
  p_agent TEXT DEFAULT 'general',
  p_idle_minutes INTEGER DEFAULT 30
)
RETURNS UUID AS $$
DECLARE
  v_conversation_id UUID;
  v_last_message_at TIMESTAMPTZ;
BEGIN
  -- Look for an active conversation on this channel
  SELECT id, last_message_at INTO v_conversation_id, v_last_message_at
  FROM conversations
  WHERE channel = p_channel AND status = 'active'
  ORDER BY started_at DESC
  LIMIT 1;

  -- If found but idle too long, expire it and create new
  IF v_conversation_id IS NOT NULL AND v_last_message_at IS NOT NULL
     AND (NOW() - v_last_message_at) > (p_idle_minutes || ' minutes')::INTERVAL THEN
    UPDATE conversations
    SET status = 'expired', ended_at = v_last_message_at
    WHERE id = v_conversation_id;
    v_conversation_id := NULL;
  END IF;

  -- If no active conversation, create one
  IF v_conversation_id IS NULL THEN
    INSERT INTO conversations (channel, agent, status, started_at, last_message_at, message_count)
    VALUES (p_channel, p_agent, 'active', NOW(), NOW(), 0)
    RETURNING id INTO v_conversation_id;
  END IF;

  RETURN v_conversation_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: Update conversation stats after a message
-- ============================================================

CREATE OR REPLACE FUNCTION update_conversation_stats(
  p_conversation_id UUID
)
RETURNS VOID AS $$
BEGIN
  UPDATE conversations
  SET message_count = message_count + 1,
      last_message_at = NOW()
  WHERE id = p_conversation_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: Close a conversation
-- ============================================================

CREATE OR REPLACE FUNCTION close_conversation(
  p_conversation_id UUID,
  p_summary TEXT DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
  UPDATE conversations
  SET status = 'closed',
      ended_at = COALESCE(last_message_at, NOW()),
      summary = COALESCE(p_summary, summary)
  WHERE id = p_conversation_id AND status = 'active';
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: Expire idle conversations (called periodically)
-- ============================================================

CREATE OR REPLACE FUNCTION expire_idle_conversations(
  p_idle_minutes INTEGER DEFAULT 30
)
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE conversations
  SET status = 'expired', ended_at = last_message_at
  WHERE status = 'active'
    AND last_message_at < NOW() - (p_idle_minutes || ' minutes')::INTERVAL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: Get conversation context for ELLIE-50 classifier
-- ============================================================

CREATE OR REPLACE FUNCTION get_conversation_context(p_channel TEXT)
RETURNS TABLE (
  conversation_id UUID,
  agent TEXT,
  summary TEXT,
  message_count INTEGER,
  started_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT c.id, c.agent, c.summary, c.message_count, c.started_at, c.last_message_at
  FROM conversations c
  WHERE c.channel = p_channel AND c.status = 'active'
  ORDER BY c.started_at DESC
  LIMIT 1;
END;
$$ LANGUAGE plpgsql;
