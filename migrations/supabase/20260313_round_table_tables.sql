-- Round Table Tables — ELLIE-694
-- Multi-phase orchestration sessions for round table coordination.

-- ============================================================
-- ROUND_TABLE_SESSIONS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS round_table_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  -- Session Identity
  query TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'completed', 'failed', 'timed_out')),
  phases_completed INTEGER DEFAULT 0,
  current_phase TEXT CHECK (current_phase IS NULL OR current_phase IN ('convene', 'discuss', 'converge', 'deliver')),

  -- Participants
  initiator_agent TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'internal',

  -- Context
  work_item_id TEXT,

  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_round_table_sessions_status ON round_table_sessions(status);
CREATE INDEX IF NOT EXISTS idx_round_table_sessions_created_at ON round_table_sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_round_table_sessions_work_item_id ON round_table_sessions(work_item_id);
CREATE INDEX IF NOT EXISTS idx_round_table_sessions_initiator ON round_table_sessions(initiator_agent);
CREATE INDEX IF NOT EXISTS idx_round_table_sessions_active ON round_table_sessions(status)
  WHERE status = 'active';

-- ============================================================
-- ROUND_TABLE_PHASES TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS round_table_phases (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  session_id UUID NOT NULL REFERENCES round_table_sessions(id) ON DELETE CASCADE,

  -- Phase Details
  phase_type TEXT NOT NULL CHECK (phase_type IN ('convene', 'discuss', 'converge', 'deliver')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'completed', 'failed', 'skipped')),
  phase_order INTEGER NOT NULL DEFAULT 0,

  -- Content
  input TEXT,
  output TEXT,
  formations_used TEXT[] DEFAULT '{}',

  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_round_table_phases_session_id ON round_table_phases(session_id);
CREATE INDEX IF NOT EXISTS idx_round_table_phases_phase_type ON round_table_phases(phase_type);
CREATE INDEX IF NOT EXISTS idx_round_table_phases_status ON round_table_phases(status);
CREATE INDEX IF NOT EXISTS idx_round_table_phases_session_order ON round_table_phases(session_id, phase_order);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE round_table_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE round_table_phases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON round_table_sessions FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON round_table_phases FOR ALL USING (true);
