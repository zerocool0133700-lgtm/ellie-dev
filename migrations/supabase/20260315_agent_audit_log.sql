-- Agent Audit Log — ELLIE-728
-- Complete audit trail of agent actions for governance, compliance, and debugging.
-- No PII — reference IDs only, not content.

-- ============================================================
-- AGENT_AUDIT_LOG TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_audit_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Who
  agent_id UUID NOT NULL REFERENCES agents(id),
  company_id UUID REFERENCES companies(id),

  -- What
  action_type TEXT NOT NULL CHECK (action_type IN (
    'dispatch', 'checkout', 'completion', 'failure',
    'approval_requested', 'approval_granted', 'approval_denied',
    'delegation', 'escalation', 'budget_exceeded'
  )),

  -- Details (reference IDs, not content — no PII)
  action_detail JSONB NOT NULL DEFAULT '{}',

  -- Optional link to formation session
  formation_session_id UUID REFERENCES formation_sessions(id),

  -- Optional link to work item
  work_item_id TEXT
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_audit_log_agent
  ON agent_audit_log(agent_id);

CREATE INDEX IF NOT EXISTS idx_audit_log_company
  ON agent_audit_log(company_id)
  WHERE company_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_log_action_type
  ON agent_audit_log(action_type);

CREATE INDEX IF NOT EXISTS idx_audit_log_created
  ON agent_audit_log(created_at DESC);

-- Composite: agent + time range queries
CREATE INDEX IF NOT EXISTS idx_audit_log_agent_time
  ON agent_audit_log(agent_id, created_at DESC);

-- Composite: company + time range queries
CREATE INDEX IF NOT EXISTS idx_audit_log_company_time
  ON agent_audit_log(company_id, created_at DESC)
  WHERE company_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_log_session
  ON agent_audit_log(formation_session_id)
  WHERE formation_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_log_work_item
  ON agent_audit_log(work_item_id)
  WHERE work_item_id IS NOT NULL;

-- ============================================================
-- RETENTION POLICY TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_retention_policies (
  company_id UUID PRIMARY KEY REFERENCES companies(id),
  retention_days INTEGER NOT NULL DEFAULT 90,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE audit_retention_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON audit_retention_policies FOR ALL USING (true);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE agent_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON agent_audit_log FOR ALL USING (true);
