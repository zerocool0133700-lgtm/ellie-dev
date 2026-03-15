-- Company Scoping — ELLIE-724
-- Foundation for multi-tenancy. Adds companies table and company_id
-- foreign key to all relevant tables for data isolation.

-- ============================================================
-- COMPANIES TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS companies (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'archived')),

  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_companies_slug ON companies(slug);
CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);

-- ============================================================
-- DEFAULT COMPANY (for Dave's existing data)
-- ============================================================
INSERT INTO companies (id, name, slug, status)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Ellie Labs',
  'ellie-labs',
  'active'
)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- ADD company_id TO CORE TABLES
-- ============================================================

-- agents
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);

-- formation_sessions
ALTER TABLE formation_sessions
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);

-- work_sessions
ALTER TABLE work_sessions
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);

-- agent_budgets
ALTER TABLE agent_budgets
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);

-- ============================================================
-- BACKFILL EXISTING DATA TO DEFAULT COMPANY
-- ============================================================
UPDATE agents
  SET company_id = '00000000-0000-0000-0000-000000000001'
  WHERE company_id IS NULL;

UPDATE formation_sessions
  SET company_id = '00000000-0000-0000-0000-000000000001'
  WHERE company_id IS NULL;

UPDATE work_sessions
  SET company_id = '00000000-0000-0000-0000-000000000001'
  WHERE company_id IS NULL;

UPDATE agent_budgets
  SET company_id = '00000000-0000-0000-0000-000000000001'
  WHERE company_id IS NULL;

-- ============================================================
-- INDEXES FOR COMPANY SCOPING
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_agents_company
  ON agents(company_id);

CREATE INDEX IF NOT EXISTS idx_formation_sessions_company
  ON formation_sessions(company_id);

CREATE INDEX IF NOT EXISTS idx_work_sessions_company
  ON work_sessions(company_id);

CREATE INDEX IF NOT EXISTS idx_agent_budgets_company
  ON agent_budgets(company_id);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON companies FOR ALL USING (true);
