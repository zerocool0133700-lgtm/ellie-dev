-- Work Sessions Tables
-- Tracks Claude Code work sessions tied to Plane work items

-- Main work sessions table
CREATE TABLE IF NOT EXISTS work_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT UNIQUE NOT NULL,
  work_item_id TEXT NOT NULL,
  work_item_title TEXT NOT NULL,
  agent TEXT NOT NULL,
  repository TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'blocked', 'paused')),
  summary TEXT,
  deliverables JSONB,
  next_steps TEXT,
  time_spent_minutes INTEGER,
  started_at TIMESTAMPTZ NOT NULL,
  last_activity_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Progress updates during sessions
CREATE TABLE IF NOT EXISTS work_session_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL REFERENCES work_sessions(session_id) ON DELETE CASCADE,
  work_item_id TEXT NOT NULL,
  update_type TEXT NOT NULL CHECK (update_type IN ('progress', 'decision', 'milestone', 'blocker')),
  summary TEXT NOT NULL,
  details JSONB,
  timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Architectural and implementation decisions
CREATE TABLE IF NOT EXISTS work_session_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL REFERENCES work_sessions(session_id) ON DELETE CASCADE,
  work_item_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  alternatives_considered TEXT[],
  impact TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_work_sessions_work_item ON work_sessions(work_item_id);
CREATE INDEX IF NOT EXISTS idx_work_sessions_status ON work_sessions(status);
CREATE INDEX IF NOT EXISTS idx_work_sessions_started_at ON work_sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_session_updates_session ON work_session_updates(session_id);
CREATE INDEX IF NOT EXISTS idx_work_session_decisions_session ON work_session_decisions(session_id);

-- Enable RLS
ALTER TABLE work_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_session_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_session_decisions ENABLE ROW LEVEL SECURITY;

-- Policies (allow all for now, tighten later)
CREATE POLICY "Allow all on work_sessions" ON work_sessions FOR ALL USING (true);
CREATE POLICY "Allow all on work_session_updates" ON work_session_updates FOR ALL USING (true);
CREATE POLICY "Allow all on work_session_decisions" ON work_session_decisions FOR ALL USING (true);
