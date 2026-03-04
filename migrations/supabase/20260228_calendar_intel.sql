-- ELLIE-319: Calendar Intel Module — event intel, prep tracking, conflict detection, patterns
-- Run against Supabase SQL editor

-- ── 1. Calendar intel table (event-level intelligence) ───────────

CREATE TABLE IF NOT EXISTS calendar_intel (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id TEXT NOT NULL,             -- external_id from calendar_events (forest DB)
  provider TEXT NOT NULL,             -- google, outlook, apple
  title TEXT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  location TEXT,
  attendees JSONB DEFAULT '[]',
  organizer TEXT,
  meeting_url TEXT,
  all_day BOOLEAN DEFAULT false,

  -- Intel fields
  meeting_type TEXT CHECK (meeting_type IN ('one_on_one', 'small_group', 'large_meeting', 'focus_block', 'personal', 'external', 'recurring_standup', 'unknown')) DEFAULT 'unknown',
  energy_cost TEXT CHECK (energy_cost IN ('high', 'medium', 'low')) DEFAULT 'medium',
  prep_status TEXT CHECK (prep_status IN ('not_needed', 'needed', 'ready', 'reviewed')) DEFAULT 'not_needed',
  prep_notes TEXT,                    -- auto-generated or user-added prep context
  prep_generated_at TIMESTAMPTZ,

  -- Conflict/alert tracking
  has_conflict BOOLEAN DEFAULT false,
  conflict_with TEXT[],               -- event_ids of conflicting events
  is_back_to_back BOOLEAN DEFAULT false,
  travel_warning BOOLEAN DEFAULT false,

  -- Status
  reviewed BOOLEAN DEFAULT false,
  reviewed_at TIMESTAMPTZ,

  last_synced TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (event_id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_intel_start ON calendar_intel(start_time);
CREATE INDEX IF NOT EXISTS idx_calendar_intel_upcoming ON calendar_intel(start_time)
  WHERE reviewed = false;
CREATE INDEX IF NOT EXISTS idx_calendar_intel_prep ON calendar_intel(prep_status, start_time)
  WHERE prep_status IN ('needed', 'ready');
CREATE INDEX IF NOT EXISTS idx_calendar_intel_conflicts ON calendar_intel(has_conflict)
  WHERE has_conflict = true;

ALTER TABLE calendar_intel ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON calendar_intel FOR ALL USING (true) WITH CHECK (true);

-- ── 2. Calendar patterns table (aggregated schedule insights) ────

CREATE TABLE IF NOT EXISTS calendar_patterns (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  pattern_type TEXT NOT NULL CHECK (pattern_type IN (
    'weekly_summary', 'focus_hours', 'meeting_density', 'busy_day',
    'back_to_back_streak', 'energy_pattern', 'buffer_preference'
  )),
  day_of_week INTEGER,                -- 0=Sun..6=Sat, null for weekly/general
  hour_of_day INTEGER,                -- 0-23, null for daily/weekly
  data JSONB NOT NULL DEFAULT '{}',   -- pattern-specific data
  sample_size INTEGER DEFAULT 0,      -- how many data points
  confidence REAL DEFAULT 0.0,        -- 0.0-1.0
  period_start DATE,                  -- analysis window start
  period_end DATE,                    -- analysis window end
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calendar_patterns_type ON calendar_patterns(pattern_type);
CREATE INDEX IF NOT EXISTS idx_calendar_patterns_period ON calendar_patterns(period_end DESC);

ALTER TABLE calendar_patterns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON calendar_patterns FOR ALL USING (true) WITH CHECK (true);

-- ── 3. Calendar intel preferences ────────────────────────────────

CREATE TABLE IF NOT EXISTS calendar_intel_preferences (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE calendar_intel_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON calendar_intel_preferences FOR ALL USING (true) WITH CHECK (true);

-- Seed defaults
INSERT INTO calendar_intel_preferences (key, value) VALUES
  ('prep_keywords', '["review", "demo", "presentation", "interview", "pitch", "standup", "retro", "planning", "1:1", "one on one"]'),
  ('large_meeting_threshold', '5'),
  ('back_to_back_minutes', '15'),
  ('high_density_threshold', '5'),
  ('focus_block_min_hours', '2'),
  ('travel_buffer_minutes', '30'),
  ('prep_lookahead_hours', '24'),
  ('analysis_window_days', '30')
ON CONFLICT (key) DO NOTHING;
