-- ELLIE-318: Comms Assistant Module — thread persistence + preferences
-- Run against Supabase SQL editor

-- ── 1. Thread tracking table ───────────────────────────────────

CREATE TABLE IF NOT EXISTS comms_threads (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  thread_id TEXT NOT NULL,           -- provider-prefixed unique ID
  provider TEXT NOT NULL,            -- telegram, gchat, gmail
  channel TEXT,                      -- channel/conversation name
  subject TEXT,                      -- thread subject (email) or first message preview
  participants JSONB DEFAULT '[]',   -- [{name, email, username}]
  last_message_at TIMESTAMPTZ NOT NULL,
  last_sender TEXT,                  -- display name of last sender
  message_count INTEGER DEFAULT 1,
  awaiting_reply BOOLEAN DEFAULT true,
  priority TEXT CHECK (priority IN ('critical', 'high', 'normal', 'low')) DEFAULT 'normal',
  snoozed_until TIMESTAMPTZ,        -- null = not snoozed
  resolved BOOLEAN DEFAULT false,
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (thread_id)
);

CREATE INDEX IF NOT EXISTS idx_comms_threads_stale
  ON comms_threads(awaiting_reply, last_message_at)
  WHERE awaiting_reply = true AND resolved = false;
CREATE INDEX IF NOT EXISTS idx_comms_threads_provider ON comms_threads(provider);
CREATE INDEX IF NOT EXISTS idx_comms_threads_resolved ON comms_threads(resolved, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_comms_threads_snoozed ON comms_threads(snoozed_until)
  WHERE snoozed_until IS NOT NULL;

-- RLS (single-user system)
ALTER TABLE comms_threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON comms_threads FOR ALL USING (true) WITH CHECK (true);

-- ── 2. Thread-message link (for drill-down) ────────────────────

CREATE TABLE IF NOT EXISTS comms_thread_messages (
  thread_id UUID REFERENCES comms_threads(id) ON DELETE CASCADE,
  message_id UUID,                   -- unified_messages.id
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (thread_id, message_id)
);

ALTER TABLE comms_thread_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON comms_thread_messages FOR ALL USING (true) WITH CHECK (true);

-- ── 3. Comms preferences ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS comms_preferences (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE comms_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON comms_preferences FOR ALL USING (true) WITH CHECK (true);

-- Seed default preferences
INSERT INTO comms_preferences (key, value) VALUES
  ('stale_thresholds', '{"telegram": 4, "gchat": 4, "gmail": 48}'),
  ('auto_gtd_create', 'true'),
  ('gtd_threshold_hours', '72')
ON CONFLICT (key) DO NOTHING;
