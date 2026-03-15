-- Per-Agent & Per-Formation Cost Tracking — ELLIE-722
-- Track token usage and costs per agent and per formation session.
-- Enables budget enforcement and burn-rate visibility.

-- ============================================================
-- AGENT_BUDGETS TABLE
-- ============================================================
-- One row per agent. Tracks monthly budget and current spend.
CREATE TABLE IF NOT EXISTS agent_budgets (
  agent_id UUID PRIMARY KEY REFERENCES agents(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Budget config
  monthly_budget_cents INTEGER NOT NULL DEFAULT 0,

  -- Current period spend
  spent_this_month_cents INTEGER NOT NULL DEFAULT 0,

  -- When the current budget period started (resets monthly)
  budget_period_start TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', NOW())
);

-- ============================================================
-- FORMATION_COSTS TABLE
-- ============================================================
-- One row per agent per formation session dispatch.
-- Fine-grained cost ledger for per-formation breakdown.
CREATE TABLE IF NOT EXISTS formation_costs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  formation_session_id UUID NOT NULL REFERENCES formation_sessions(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),

  -- Usage
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,

  -- Computed cost in cents (integer to avoid float rounding)
  cost_cents INTEGER NOT NULL DEFAULT 0,

  -- Model used for this dispatch
  model TEXT,

  recorded_at TIMESTAMPTZ DEFAULT NOW(),

  metadata JSONB DEFAULT '{}'
);

-- ============================================================
-- INDEXES
-- ============================================================

-- Formation cost lookups
CREATE INDEX IF NOT EXISTS idx_formation_costs_session
  ON formation_costs(formation_session_id);

CREATE INDEX IF NOT EXISTS idx_formation_costs_agent
  ON formation_costs(agent_id);

CREATE INDEX IF NOT EXISTS idx_formation_costs_recorded
  ON formation_costs(recorded_at DESC);

-- Composite: per-agent costs within a session
CREATE INDEX IF NOT EXISTS idx_formation_costs_session_agent
  ON formation_costs(formation_session_id, agent_id);

-- Budget period queries
CREATE INDEX IF NOT EXISTS idx_agent_budgets_period
  ON agent_budgets(budget_period_start);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE agent_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE formation_costs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON agent_budgets FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON formation_costs FOR ALL USING (true);
