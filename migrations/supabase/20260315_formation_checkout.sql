-- Formation Atomic Checkout — ELLIE-721
-- Prevent two agents from running the same formation simultaneously
-- via compare-and-swap checkout semantics.

-- ============================================================
-- NEW COLUMNS
-- ============================================================

-- Who currently holds the checkout (FK to agents table)
ALTER TABLE formation_sessions
  ADD COLUMN IF NOT EXISTS checked_out_by UUID REFERENCES agents(id);

-- When the checkout was acquired
ALTER TABLE formation_sessions
  ADD COLUMN IF NOT EXISTS checked_out_at TIMESTAMPTZ;

-- Checkout lifecycle status (separate from the existing `state` column
-- which tracks the formation's conversational lifecycle)
ALTER TABLE formation_sessions
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending', 'checked_out', 'in_progress', 'completed', 'failed'));

-- ============================================================
-- INDEXES
-- ============================================================

-- Fast lookup of sessions checked out by a specific agent
CREATE INDEX IF NOT EXISTS idx_formation_sessions_checked_out_by
  ON formation_sessions(checked_out_by)
  WHERE checked_out_by IS NOT NULL;

-- Fast lookup of sessions by checkout status
CREATE INDEX IF NOT EXISTS idx_formation_sessions_status
  ON formation_sessions(status);

-- Stale checkout detection: find checked-out sessions older than a threshold
CREATE INDEX IF NOT EXISTS idx_formation_sessions_stale_checkout
  ON formation_sessions(checked_out_at)
  WHERE checked_out_by IS NOT NULL AND status IN ('checked_out', 'in_progress');
