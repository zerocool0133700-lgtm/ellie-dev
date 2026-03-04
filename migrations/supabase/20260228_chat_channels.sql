-- ELLIE-334: Chat Sub-Channels — Predefined Tree + Channel Data Model
--
-- Adds hierarchical chat channels with per-channel context profiles.
-- Channels replace mode detection as the primary context mechanism.

-- ============================================================
-- CHAT CHANNELS TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS chat_channels (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  parent_id UUID REFERENCES chat_channels(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,

  -- Context profile (nullable = inherit from parent)
  context_mode TEXT CHECK (context_mode IN ('conversation', 'strategy', 'workflow', 'deep-work')),
  token_budget INTEGER,
  critical_sources TEXT[],
  suppressed_sections TEXT[],

  -- Channel behavior
  is_ephemeral BOOLEAN NOT NULL DEFAULT FALSE,
  work_item_id TEXT,
  archived_at TIMESTAMPTZ,

  -- Metadata
  description TEXT,
  icon TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_channels_slug
  ON chat_channels(slug) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_chat_channels_parent
  ON chat_channels(parent_id);
CREATE INDEX IF NOT EXISTS idx_chat_channels_work_item
  ON chat_channels(work_item_id) WHERE work_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chat_channels_active
  ON chat_channels(archived_at) WHERE archived_at IS NULL;

-- ============================================================
-- LINK CONVERSATIONS TO CHANNELS
-- ============================================================

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES chat_channels(id);
CREATE INDEX IF NOT EXISTS idx_conversations_channel_id ON conversations(channel_id);

-- ============================================================
-- SEED DEFAULT CHANNEL TREE
-- ============================================================

-- Top-level channels
INSERT INTO chat_channels (id, name, slug, parent_id, sort_order, context_mode, description, icon)
VALUES
  ('a0000000-0000-0000-0000-000000000001', 'General', 'general', NULL, 1, 'conversation', 'Casual conversation, quick questions, daily check-ins', NULL),
  ('a0000000-0000-0000-0000-000000000002', 'Strategy', 'strategy', NULL, 2, 'strategy', 'Planning, roadmap, architecture, prioritization', NULL),
  ('a0000000-0000-0000-0000-000000000003', 'Deep Work', 'deep-work', NULL, 3, 'deep-work', 'Focused ticket work, implementation, debugging', NULL),
  ('a0000000-0000-0000-0000-000000000004', 'Ops', 'ops', NULL, 4, 'workflow', 'Agent management, deployments, queue monitoring', NULL),
  ('a0000000-0000-0000-0000-000000000005', 'Personal', 'personal', NULL, 5, 'conversation', 'Personal notes, reminders, non-work topics', NULL)
ON CONFLICT DO NOTHING;

-- Strategy sub-channels
INSERT INTO chat_channels (id, name, slug, parent_id, sort_order, context_mode, description)
VALUES
  ('a0000000-0000-0000-0000-000000000010', 'Architecture', 'strategy/architecture', 'a0000000-0000-0000-0000-000000000002', 1, NULL, 'System design and technical architecture'),
  ('a0000000-0000-0000-0000-000000000011', 'Roadmap', 'strategy/roadmap', 'a0000000-0000-0000-0000-000000000002', 2, NULL, 'Feature planning and milestone tracking'),
  ('a0000000-0000-0000-0000-000000000012', 'Prioritization', 'strategy/prioritization', 'a0000000-0000-0000-0000-000000000002', 3, NULL, 'What to work on next')
ON CONFLICT DO NOTHING;

-- Ops sub-channels
INSERT INTO chat_channels (id, name, slug, parent_id, sort_order, context_mode, description)
VALUES
  ('a0000000-0000-0000-0000-000000000020', 'Creatures', 'ops/creatures', 'a0000000-0000-0000-0000-000000000004', 1, NULL, 'Agent status, dispatch, monitoring'),
  ('a0000000-0000-0000-0000-000000000021', 'Deployments', 'ops/deployments', 'a0000000-0000-0000-0000-000000000004', 2, NULL, 'Service restarts, systemd, infrastructure')
ON CONFLICT DO NOTHING;

-- ============================================================
-- UPDATE get_or_create_conversation RPC
-- ============================================================

CREATE OR REPLACE FUNCTION get_or_create_conversation(
  p_channel TEXT,
  p_agent TEXT DEFAULT 'general',
  p_idle_minutes INTEGER DEFAULT 30,
  p_channel_id UUID DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_conversation_id UUID;
  v_last_message_at TIMESTAMPTZ;
BEGIN
  -- Look for an active conversation on this channel (+ channel_id if provided)
  SELECT id, last_message_at INTO v_conversation_id, v_last_message_at
  FROM conversations
  WHERE channel = p_channel
    AND status = 'active'
    AND (p_channel_id IS NULL OR channel_id = p_channel_id)
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
    INSERT INTO conversations (channel, agent, status, started_at, last_message_at, message_count, channel_id)
    VALUES (p_channel, p_agent, 'active', NOW(), NOW(), 0, p_channel_id)
    RETURNING id INTO v_conversation_id;
  END IF;

  RETURN v_conversation_id;
END;
$$ LANGUAGE plpgsql;
