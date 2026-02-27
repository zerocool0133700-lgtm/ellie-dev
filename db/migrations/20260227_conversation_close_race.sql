-- ELLIE-232: Fix conversation expiry race condition
--
-- Problem: Three independent mechanisms can close the same conversation simultaneously:
--   1. Relay 5-min interval (queries stale → closeConversation)
--   2. Per-channel idle timers (10 min → closeActiveConversation)
--   3. get_or_create_conversation RPC (silently expires idle → lost memories)
--
-- Fix: Add 'closing' status as an atomic claim. Only one caller wins the
-- active→closing transition. The winner extracts memories, then marks 'closed'.

-- ============================================================
-- ADD 'closing' to status constraint
-- ============================================================

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_status_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_status_check
  CHECK (status IN ('active', 'closing', 'closed', 'expired'));

-- ============================================================
-- RPC: Claim a conversation for closing (atomic)
-- Returns the row if this caller won the claim, NULL otherwise.
-- ============================================================

CREATE OR REPLACE FUNCTION claim_conversation_for_close(
  p_conversation_id UUID
)
RETURNS TABLE (
  id UUID,
  channel TEXT,
  agent TEXT,
  summary TEXT,
  message_count INTEGER,
  started_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  UPDATE conversations
  SET status = 'closing'
  WHERE conversations.id = p_conversation_id AND conversations.status = 'active'
  RETURNING
    conversations.id,
    conversations.channel,
    conversations.agent,
    conversations.summary,
    conversations.message_count,
    conversations.started_at,
    conversations.last_message_at;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- RPC: Finalize a closed conversation (closing → closed)
-- ============================================================

CREATE OR REPLACE FUNCTION finalize_conversation_close(
  p_conversation_id UUID,
  p_summary TEXT DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
  UPDATE conversations
  SET status = 'closed',
      ended_at = COALESCE(last_message_at, NOW()),
      summary = COALESCE(p_summary, summary)
  WHERE id = p_conversation_id AND status = 'closing';
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Update close_conversation to accept both active and closing
-- (backwards compat for simple closes of low-message conversations)
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
  WHERE id = p_conversation_id AND status IN ('active', 'closing');
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Fix get_or_create_conversation: don't silently expire
-- Instead of expiring the old conversation (losing memories),
-- mark it 'closing' so the relay picks it up for extraction.
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
  v_status TEXT;
BEGIN
  -- Look for an active (or closing) conversation on this channel
  SELECT id, last_message_at, status INTO v_conversation_id, v_last_message_at, v_status
  FROM conversations
  WHERE channel = p_channel AND status IN ('active', 'closing')
  ORDER BY started_at DESC
  LIMIT 1;

  -- If 'closing', someone is already handling it — create a new one
  IF v_status = 'closing' THEN
    v_conversation_id := NULL;
  -- If active but idle too long, claim it for close (so relay extracts memories)
  ELSIF v_conversation_id IS NOT NULL AND v_last_message_at IS NOT NULL
     AND (NOW() - v_last_message_at) > (p_idle_minutes || ' minutes')::INTERVAL THEN
    UPDATE conversations
    SET status = 'closing'
    WHERE id = v_conversation_id AND status = 'active';
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
-- Update expire_idle_conversations: skip 'closing' ones
-- (they're already being handled)
-- ============================================================

CREATE OR REPLACE FUNCTION expire_idle_conversations(
  p_idle_minutes INTEGER DEFAULT 30
)
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  -- Only move active→closing (not directly to expired)
  -- The relay will pick these up and extract memories before finalizing
  UPDATE conversations
  SET status = 'closing'
  WHERE status = 'active'
    AND last_message_at < NOW() - (p_idle_minutes || ' minutes')::INTERVAL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Recovery: unstick conversations stuck in 'closing' > 10 min
-- (process crashed mid-extraction)
-- ============================================================

CREATE OR REPLACE FUNCTION recover_stuck_closing_conversations(
  p_stuck_minutes INTEGER DEFAULT 10
)
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE conversations
  SET status = 'closed',
      ended_at = COALESCE(last_message_at, NOW())
  WHERE status = 'closing'
    AND last_message_at < NOW() - (p_stuck_minutes || ' minutes')::INTERVAL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;
