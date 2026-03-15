-- Formation Approval Gates — ELLIE-726
-- Human-in-the-loop approval for high-stakes formation outputs.
-- Agents propose, Dave disposes.

-- ============================================================
-- FORMATION_APPROVALS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS formation_approvals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Which formation session needs approval
  formation_session_id UUID NOT NULL REFERENCES formation_sessions(id) ON DELETE CASCADE,

  -- Who must approve (NULL = any human)
  required_approver_id UUID REFERENCES agents(id),

  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'timed_out')),

  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,

  -- Timeout config (seconds from requested_at)
  timeout_seconds INTEGER NOT NULL DEFAULT 3600,

  -- What is being approved (summary for the human)
  summary TEXT NOT NULL,

  -- Detailed context for the approval decision
  context JSONB DEFAULT '{}',

  -- Who actually responded (may differ from required_approver_id)
  responded_by TEXT,

  -- Reason for rejection (optional)
  rejection_reason TEXT,

  -- Channel where the approval was requested (telegram, gchat, etc.)
  channel TEXT NOT NULL DEFAULT 'telegram',

  -- External message ID for inline button updates
  external_message_id TEXT
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_formation_approvals_session
  ON formation_approvals(formation_session_id);

CREATE INDEX IF NOT EXISTS idx_formation_approvals_status
  ON formation_approvals(status);

CREATE INDEX IF NOT EXISTS idx_formation_approvals_pending
  ON formation_approvals(requested_at ASC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_formation_approvals_approver
  ON formation_approvals(required_approver_id)
  WHERE required_approver_id IS NOT NULL;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE formation_approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON formation_approvals FOR ALL USING (true);
