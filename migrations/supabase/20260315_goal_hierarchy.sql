-- Goal Hierarchy Integration — ELLIE-731
-- Tie formation sessions to company/team goals.
-- Agents see the 'why' behind every task via goal ancestry.

-- ============================================================
-- GOALS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS goals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Ownership
  company_id UUID NOT NULL REFERENCES companies(id),

  -- Hierarchy (self-referential)
  parent_goal_id UUID REFERENCES goals(id),

  -- Goal details
  title TEXT NOT NULL,
  description TEXT,
  level TEXT NOT NULL DEFAULT 'team'
    CHECK (level IN ('company', 'team', 'individual')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'completed', 'abandoned')),

  -- Target metrics
  target_metric TEXT,
  target_value NUMERIC,
  current_value NUMERIC DEFAULT 0,
  unit TEXT,

  -- Timeline
  due_date DATE,

  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_goals_company ON goals(company_id);
CREATE INDEX IF NOT EXISTS idx_goals_parent ON goals(parent_goal_id) WHERE parent_goal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_goals_level ON goals(level);
CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);
CREATE INDEX IF NOT EXISTS idx_goals_company_level ON goals(company_id, level);

-- ============================================================
-- LINK FORMATION SESSIONS TO GOALS
-- ============================================================
ALTER TABLE formation_sessions
  ADD COLUMN IF NOT EXISTS goal_id UUID REFERENCES goals(id);

CREATE INDEX IF NOT EXISTS idx_formation_sessions_goal
  ON formation_sessions(goal_id)
  WHERE goal_id IS NOT NULL;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE goals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON goals FOR ALL USING (true);
