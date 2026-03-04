-- ELLIE-321: Analytics Module — activity_log, productivity_metrics tables
--
-- activity_log: Every ingested activity classified by category with duration.
-- productivity_metrics: Daily rollup of categorized time for trend analysis.
--
-- Categories: communication, meetings, deep_work, admin, personal

-- ── activity_log ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS activity_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- What happened
  activity_type TEXT NOT NULL CHECK (activity_type IN (
    'message_sent', 'message_received', 'meeting', 'calendar_event',
    'task_completed', 'task_created', 'focus_block', 'email_sent',
    'email_received', 'code_session', 'admin', 'other'
  )),
  category TEXT NOT NULL CHECK (category IN (
    'communication', 'meetings', 'deep_work', 'admin', 'personal'
  )),

  -- Timing
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  duration_minutes FLOAT,                -- computed or estimated

  -- Source
  source TEXT NOT NULL,                   -- provider: telegram, gchat, gmail, calendar, gtd, etc.
  source_id TEXT,                         -- reference to original item (message id, event id, etc.)

  -- Context
  title TEXT,                             -- short description
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_al_started_at ON activity_log(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_al_category ON activity_log(category, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_al_source ON activity_log(source);
CREATE INDEX IF NOT EXISTS idx_al_date ON activity_log(CAST(started_at AT TIME ZONE 'America/Chicago' AS date));

-- ── productivity_metrics ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS productivity_metrics (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Date for this rollup
  metric_date DATE NOT NULL UNIQUE,

  -- Time by category (minutes)
  communication_min FLOAT NOT NULL DEFAULT 0,
  meetings_min FLOAT NOT NULL DEFAULT 0,
  deep_work_min FLOAT NOT NULL DEFAULT 0,
  admin_min FLOAT NOT NULL DEFAULT 0,
  personal_min FLOAT NOT NULL DEFAULT 0,
  total_min FLOAT NOT NULL DEFAULT 0,

  -- Counts
  message_count INTEGER NOT NULL DEFAULT 0,
  meeting_count INTEGER NOT NULL DEFAULT 0,
  task_completed_count INTEGER NOT NULL DEFAULT 0,
  email_count INTEGER NOT NULL DEFAULT 0,

  -- Focus analysis
  focus_blocks INTEGER NOT NULL DEFAULT 0,       -- number of uninterrupted blocks >= 30min
  longest_focus_min FLOAT NOT NULL DEFAULT 0,    -- longest uninterrupted deep work block
  context_switches INTEGER NOT NULL DEFAULT 0,   -- category changes per day

  -- Work hours
  first_activity_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ,
  work_hours FLOAT NOT NULL DEFAULT 0,           -- span from first to last activity

  -- Scores (0-1)
  focus_score FLOAT,                             -- quality of focus time
  balance_score FLOAT,                           -- work-life balance indicator

  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_pm_date ON productivity_metrics(metric_date DESC);

-- RLS
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON activity_log FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE productivity_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON productivity_metrics FOR ALL USING (true) WITH CHECK (true);
