-- Per-Company Data Isolation RLS Policies — ELLIE-730
-- Critical for multi-tenancy security. Every query scoped to active company.
-- Company context set via: SET app.current_company_id = '<uuid>';

-- ============================================================
-- HELPER: Current Company from Session Context
-- ============================================================
-- All RLS policies use this function to get the active company.
-- Set before each request: SET LOCAL app.current_company_id = 'uuid';

CREATE OR REPLACE FUNCTION current_company_id()
RETURNS UUID AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_company_id', true), '')::uuid;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================
-- SYSTEM AGENT FLAG
-- ============================================================
-- System agents (company_id IS NULL) are accessible across all companies.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_system_agent BOOLEAN DEFAULT false;

-- ============================================================
-- RLS POLICIES: AGENTS
-- ============================================================
-- Drop the blanket "Allow all" policy if it exists, replace with scoped ones.
DROP POLICY IF EXISTS "Allow all for service role" ON agents;

-- Service role bypasses RLS (Supabase default for service_role).
-- For authenticated users, scope to company OR system agents.
CREATE POLICY "company_isolation_agents" ON agents
  FOR ALL
  USING (
    company_id = current_company_id()
    OR is_system_agent = true
    OR current_company_id() IS NULL  -- No context set = service role
  );

-- ============================================================
-- RLS POLICIES: FORMATION_SESSIONS
-- ============================================================
DROP POLICY IF EXISTS "Allow all for service role" ON formation_sessions;

CREATE POLICY "company_isolation_formation_sessions" ON formation_sessions
  FOR ALL
  USING (
    company_id = current_company_id()
    OR current_company_id() IS NULL
  );

-- ============================================================
-- RLS POLICIES: WORK_SESSIONS
-- ============================================================
DROP POLICY IF EXISTS "Allow all for service role" ON work_sessions;

CREATE POLICY "company_isolation_work_sessions" ON work_sessions
  FOR ALL
  USING (
    company_id = current_company_id()
    OR current_company_id() IS NULL
  );

-- ============================================================
-- RLS POLICIES: AGENT_BUDGETS
-- ============================================================
DROP POLICY IF EXISTS "Allow all for service role" ON agent_budgets;

CREATE POLICY "company_isolation_agent_budgets" ON agent_budgets
  FOR ALL
  USING (
    company_id = current_company_id()
    OR current_company_id() IS NULL
  );

-- ============================================================
-- RLS POLICIES: AGENT_AUDIT_LOG
-- ============================================================
DROP POLICY IF EXISTS "Allow all for service role" ON agent_audit_log;

CREATE POLICY "company_isolation_agent_audit_log" ON agent_audit_log
  FOR ALL
  USING (
    company_id = current_company_id()
    OR current_company_id() IS NULL
  );

-- ============================================================
-- RLS POLICIES: AGENT_DELEGATIONS
-- ============================================================
-- Delegations inherit company from the agents involved.
-- Scoped via a join check rather than a direct column.
DROP POLICY IF EXISTS "Allow all for service role" ON agent_delegations;

CREATE POLICY "company_isolation_agent_delegations" ON agent_delegations
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM agents
      WHERE agents.id = agent_delegations.from_agent_id
        AND (agents.company_id = current_company_id() OR agents.is_system_agent = true)
    )
    OR current_company_id() IS NULL
  );
