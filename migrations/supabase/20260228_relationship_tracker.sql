-- ELLIE-320: Relationship Tracker — contact profiles, interaction log, health scoring
-- Run against Supabase SQL editor

-- ── 1. Relationship profiles ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS relationship_profiles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  identifier TEXT NOT NULL,             -- canonical ID (lowercase email, username, or name)
  display_name TEXT,
  emails TEXT[] DEFAULT '{}',           -- all known email addresses
  usernames TEXT[] DEFAULT '{}',        -- all known usernames
  names TEXT[] DEFAULT '{}',            -- all known display names
  provider_ids JSONB DEFAULT '{}',      -- { telegram: "123", gchat: "456" }
  channels TEXT[] DEFAULT '{}',         -- which providers they communicate through

  -- Classification
  importance INTEGER DEFAULT 3 CHECK (importance >= 1 AND importance <= 5), -- 1=low, 5=critical
  tags TEXT[] DEFAULT '{}',             -- user-defined tags: vip, family, work, etc.
  notes TEXT,                           -- user notes about this contact
  suppressed BOOLEAN DEFAULT false,     -- mailing lists, automated senders

  -- Health scoring
  health_score REAL DEFAULT 0.5 CHECK (health_score >= 0 AND health_score <= 1),
  health_status TEXT CHECK (health_status IN ('healthy', 'active', 'declining', 'dormant', 'at_risk', 'new')) DEFAULT 'new',
  recency_score REAL DEFAULT 0,         -- 0-0.3
  frequency_score REAL DEFAULT 0,       -- 0-0.3
  consistency_score REAL DEFAULT 0,     -- 0-0.2
  quality_score REAL DEFAULT 0,         -- 0-0.2

  -- Interaction stats (aggregated)
  message_count INTEGER DEFAULT 0,
  last_interaction_at TIMESTAMPTZ,
  first_interaction_at TIMESTAMPTZ,
  avg_gap_hours REAL,                   -- average hours between interactions
  typical_gap_hours REAL,               -- median gap (for silence detection)

  -- Follow-up tracking
  needs_follow_up BOOLEAN DEFAULT false,
  follow_up_reason TEXT,
  follow_up_since TIMESTAMPTZ,

  -- People table link (Forest)
  person_id UUID,                       -- links to people.id in Forest DB if matched

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (identifier)
);

CREATE INDEX IF NOT EXISTS idx_rel_profiles_health ON relationship_profiles(health_status, health_score DESC);
CREATE INDEX IF NOT EXISTS idx_rel_profiles_importance ON relationship_profiles(importance DESC)
  WHERE suppressed = false;
CREATE INDEX IF NOT EXISTS idx_rel_profiles_follow_up ON relationship_profiles(needs_follow_up)
  WHERE needs_follow_up = true;
CREATE INDEX IF NOT EXISTS idx_rel_profiles_last_interaction ON relationship_profiles(last_interaction_at DESC);

ALTER TABLE relationship_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON relationship_profiles FOR ALL USING (true) WITH CHECK (true);

-- ── 2. Interaction log ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS interaction_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  profile_id UUID NOT NULL REFERENCES relationship_profiles(id) ON DELETE CASCADE,
  message_id UUID,                      -- unified_messages.id (nullable for manual entries)
  provider TEXT NOT NULL,
  direction TEXT CHECK (direction IN ('inbound', 'outbound')) DEFAULT 'inbound',
  content_type TEXT DEFAULT 'text',     -- text, voice, event, etc.
  channel TEXT,                         -- conversation/thread identifier
  summary TEXT,                         -- brief content preview (first 100 chars)
  interaction_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_interaction_log_profile ON interaction_log(profile_id, interaction_at DESC);
CREATE INDEX IF NOT EXISTS idx_interaction_log_time ON interaction_log(interaction_at DESC);

ALTER TABLE interaction_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON interaction_log FOR ALL USING (true) WITH CHECK (true);

-- ── 3. Relationship preferences ──────────────────────────────────

CREATE TABLE IF NOT EXISTS relationship_preferences (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE relationship_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON relationship_preferences FOR ALL USING (true) WITH CHECK (true);

-- Seed defaults
INSERT INTO relationship_preferences (key, value) VALUES
  ('dormant_threshold_days', '90'),
  ('declining_threshold_days', '30'),
  ('vip_neglect_days', '30'),
  ('silence_multiplier', '2'),
  ('auto_suppress_patterns', '["noreply", "no-reply", "notification", "mailer-daemon", "bounce"]'),
  ('health_weights', '{"recency": 0.3, "frequency": 0.3, "consistency": 0.2, "quality": 0.2}')
ON CONFLICT (key) DO NOTHING;
