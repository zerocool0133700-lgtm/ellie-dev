-- ELLIE-58: Execution engine — execution_plans table + skills.complexity column
-- Run against Supabase SQL editor

-- ============================================================
-- EXECUTION PLANS TABLE (Persistent tracking of multi-step executions)
-- ============================================================
CREATE TABLE IF NOT EXISTS execution_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id),
  mode TEXT NOT NULL CHECK (mode IN ('single', 'pipeline', 'fan-out', 'critic-loop')),
  original_message TEXT,
  steps JSONB NOT NULL DEFAULT '[]',
  total_tokens INTEGER DEFAULT 0,
  total_cost_usd NUMERIC(10,6) DEFAULT 0,
  status TEXT DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'partial')),
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_execution_plans_conversation_id ON execution_plans(conversation_id);
CREATE INDEX IF NOT EXISTS idx_execution_plans_status ON execution_plans(status);
CREATE INDEX IF NOT EXISTS idx_execution_plans_created_at ON execution_plans(created_at DESC);

ALTER TABLE execution_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON execution_plans FOR ALL USING (true);

-- ============================================================
-- SKILLS: Add complexity column (light vs heavy execution)
-- ============================================================
-- light = direct Anthropic API call (Haiku, ~300ms, no tools)
-- heavy = CLI spawn with full tool access (~30-420s)
ALTER TABLE skills ADD COLUMN IF NOT EXISTS complexity TEXT DEFAULT 'heavy'
  CHECK (complexity IN ('light', 'heavy'));

COMMENT ON COLUMN skills.complexity IS
  'Execution weight: light = direct API (fast, no tools), heavy = CLI spawn (slow, full tools)';

-- Seed known light skills (no tool access needed)
UPDATE skills SET complexity = 'light' WHERE name IN (
  'memory_store',
  'memory_recall',
  'summarization',
  'writing',
  'editing',
  'financial_analysis',
  'strategic_planning',
  'critical_review',
  'code_analysis',
  'goal_management'
);
