-- Agent Delegation Flows — ELLIE-727
-- Delegate tasks down the org chart, escalate up. Traceable audit log.

-- ============================================================
-- AGENT_DELEGATIONS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_delegations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Direction: delegate (down) or escalate (up)
  direction TEXT NOT NULL CHECK (direction IN ('delegate', 'escalate')),

  -- Who is sending and receiving
  from_agent_id UUID NOT NULL REFERENCES agents(id),
  to_agent_id UUID NOT NULL REFERENCES agents(id),

  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'completed', 'failed', 'rejected', 'cancelled')),

  -- Task details
  summary TEXT NOT NULL,
  context JSONB DEFAULT '{}',

  -- Linked work sessions
  parent_work_session_id UUID REFERENCES work_sessions(id),
  child_work_session_id UUID REFERENCES work_sessions(id),

  -- Linked work item (Plane ticket)
  work_item_id TEXT,

  -- Completion details
  accepted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result TEXT,
  result_context JSONB DEFAULT '{}'
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_delegations_from
  ON agent_delegations(from_agent_id);

CREATE INDEX IF NOT EXISTS idx_delegations_to
  ON agent_delegations(to_agent_id);

CREATE INDEX IF NOT EXISTS idx_delegations_status
  ON agent_delegations(status);

CREATE INDEX IF NOT EXISTS idx_delegations_pending
  ON agent_delegations(to_agent_id, created_at ASC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_delegations_parent_session
  ON agent_delegations(parent_work_session_id)
  WHERE parent_work_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_delegations_work_item
  ON agent_delegations(work_item_id)
  WHERE work_item_id IS NOT NULL;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE agent_delegations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON agent_delegations FOR ALL USING (true);
