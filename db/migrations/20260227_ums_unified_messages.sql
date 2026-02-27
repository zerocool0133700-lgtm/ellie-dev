-- ELLIE-293: UMS — Unified Messaging System core schema
-- Normalized store for every inbound message, event, and notification.
-- UMS is a dumb pipe: no priority, no status, no intelligence. Just capture.
-- Run against Supabase SQL editor.

-- ── 1. unified_messages table ──────────────────────────────────

CREATE TABLE IF NOT EXISTS unified_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  provider TEXT NOT NULL,               -- 'telegram', 'gmail', 'gchat', 'calendar', 'github', etc.
  provider_id TEXT NOT NULL,            -- unique ID in the source system
  channel TEXT,                         -- conversation/thread/space identifier (nullable for events)
  sender JSONB,                         -- { name, email, username, id } — shape varies by provider
  content TEXT,                         -- normalized human-readable text (nullable for non-text events)
  content_type TEXT NOT NULL DEFAULT 'text',  -- 'text', 'voice', 'image', 'event', 'task', 'notification'
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,     -- original payload — never lose data
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- when UMS captured it
  provider_timestamp TIMESTAMPTZ,       -- when it happened in the source system (if available)
  metadata JSONB DEFAULT '{}'::jsonb    -- provider-specific extras (thread_id, subject, labels, etc.)
);

-- Prevent duplicate ingestion from the same provider
CREATE UNIQUE INDEX IF NOT EXISTS idx_ums_provider_provider_id
  ON unified_messages(provider, provider_id);

-- Query patterns: by provider, by time, by content type, by sender
CREATE INDEX IF NOT EXISTS idx_ums_received_at ON unified_messages(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_ums_provider ON unified_messages(provider);
CREATE INDEX IF NOT EXISTS idx_ums_content_type ON unified_messages(content_type);
CREATE INDEX IF NOT EXISTS idx_ums_channel ON unified_messages(channel) WHERE channel IS NOT NULL;

-- RLS (single-user system)
ALTER TABLE unified_messages ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY "Allow all" ON unified_messages FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
