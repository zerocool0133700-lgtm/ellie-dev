-- ELLIE-908: Conversation isolation — prevent background ops from hijacking active context
--
-- Problem: Background operations (email polls, agent dispatch) create/modify conversations
-- on the same channel, resetting idle timers and breaking user context continuity.
--
-- Fix:
-- 1. Add `participants` column to uniquely identify conversations by participant set
-- 2. Add `initiated_by` to distinguish user vs background conversations
-- 3. Create `user_conversation_state` for per-user active conversation pointers
-- 4. Update get_or_create_conversation RPC to scope by participants

-- Add participant tracking to conversations
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS participants TEXT[] DEFAULT '{}';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS initiated_by TEXT DEFAULT 'system';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_conversations_participants
  ON conversations USING GIN (participants);
CREATE INDEX IF NOT EXISTS idx_conversations_initiated_by
  ON conversations(initiated_by) WHERE initiated_by = 'user';
CREATE INDEX IF NOT EXISTS idx_conversations_user_id
  ON conversations(user_id) WHERE user_id IS NOT NULL;

-- Per-user active conversation state
-- Each user has their own "active conversation" pointer per channel,
-- independent of what background operations do.
CREATE TABLE IF NOT EXISTS user_conversation_state (
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  channel_id UUID REFERENCES chat_channels(id),
  active_conversation_id UUID REFERENCES conversations(id),
  last_active_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, channel)
);

-- Updated RPC: scope active conversation lookup by participants
CREATE OR REPLACE FUNCTION get_or_create_conversation(
  p_channel TEXT,
  p_agent TEXT DEFAULT 'general',
  p_idle_minutes INTEGER DEFAULT 30,
  p_channel_id UUID DEFAULT NULL,
  p_user_id TEXT DEFAULT NULL,
  p_initiated_by TEXT DEFAULT 'system'
)
RETURNS UUID AS $$
DECLARE
  v_conversation_id UUID;
  v_last_message_at TIMESTAMPTZ;
  v_participants TEXT[];
BEGIN
  -- Build participant set (sorted for consistency)
  IF p_user_id IS NOT NULL THEN
    v_participants := ARRAY(SELECT unnest(ARRAY[p_user_id, p_agent]) ORDER BY 1);
  ELSE
    v_participants := ARRAY[p_agent];
  END IF;

  -- For user-initiated conversations: check user_conversation_state first
  IF p_initiated_by = 'user' AND p_user_id IS NOT NULL THEN
    SELECT active_conversation_id INTO v_conversation_id
    FROM user_conversation_state
    WHERE user_id = p_user_id AND channel = p_channel
      AND (p_channel_id IS NULL OR channel_id = p_channel_id);

    -- Validate the pointed conversation is still active
    IF v_conversation_id IS NOT NULL THEN
      SELECT last_message_at INTO v_last_message_at
      FROM conversations
      WHERE id = v_conversation_id AND status = 'active';

      IF v_last_message_at IS NOT NULL THEN
        -- Check idle timeout
        IF (NOW() - v_last_message_at) <= (p_idle_minutes || ' minutes')::INTERVAL THEN
          RETURN v_conversation_id;  -- Still active, return it
        END IF;
        -- Expired — mark it and fall through to create new
        UPDATE conversations SET status = 'expired', ended_at = v_last_message_at
        WHERE id = v_conversation_id;
      END IF;
      -- Pointed conversation is gone or expired — clear the pointer
      v_conversation_id := NULL;
    END IF;
  END IF;

  -- Fallback: look for any active conversation on this channel with matching participants
  SELECT id, last_message_at INTO v_conversation_id, v_last_message_at
  FROM conversations
  WHERE channel = p_channel
    AND status = 'active'
    AND (p_channel_id IS NULL OR channel_id = p_channel_id)
    AND (p_user_id IS NULL OR participants @> ARRAY[p_user_id])
  ORDER BY started_at DESC
  LIMIT 1;

  -- Check idle timeout on fallback match
  IF v_conversation_id IS NOT NULL AND v_last_message_at IS NOT NULL
     AND (NOW() - v_last_message_at) > (p_idle_minutes || ' minutes')::INTERVAL THEN
    UPDATE conversations
    SET status = 'expired', ended_at = v_last_message_at
    WHERE id = v_conversation_id;
    v_conversation_id := NULL;
  END IF;

  -- Create new conversation if none found
  IF v_conversation_id IS NULL THEN
    INSERT INTO conversations (channel, agent, status, started_at, last_message_at, message_count, channel_id, participants, initiated_by, user_id)
    VALUES (p_channel, p_agent, 'active', NOW(), NOW(), 0, p_channel_id, v_participants, p_initiated_by, p_user_id)
    RETURNING id INTO v_conversation_id;
  END IF;

  -- Update user's active conversation pointer
  IF p_initiated_by = 'user' AND p_user_id IS NOT NULL THEN
    INSERT INTO user_conversation_state (user_id, channel, channel_id, active_conversation_id, last_active_at)
    VALUES (p_user_id, p_channel, p_channel_id, v_conversation_id, NOW())
    ON CONFLICT (user_id, channel) DO UPDATE SET
      active_conversation_id = v_conversation_id,
      channel_id = COALESCE(EXCLUDED.channel_id, user_conversation_state.channel_id),
      last_active_at = NOW();
  END IF;

  RETURN v_conversation_id;
END;
$$ LANGUAGE plpgsql;

-- Backfill: set participants from existing messages
-- For each active conversation, derive participants from message roles and user_ids
DO $$
DECLARE
  conv RECORD;
  msg_participants TEXT[];
BEGIN
  FOR conv IN SELECT id, channel, agent FROM conversations WHERE status = 'active' LOOP
    SELECT ARRAY_AGG(DISTINCT COALESCE(user_id, role)) INTO msg_participants
    FROM messages
    WHERE conversation_id = conv.id AND user_id IS NOT NULL;

    IF msg_participants IS NOT NULL AND array_length(msg_participants, 1) > 0 THEN
      UPDATE conversations SET participants = msg_participants WHERE id = conv.id;
    ELSE
      UPDATE conversations SET participants = ARRAY[conv.agent] WHERE id = conv.id;
    END IF;
  END LOOP;
END $$;
