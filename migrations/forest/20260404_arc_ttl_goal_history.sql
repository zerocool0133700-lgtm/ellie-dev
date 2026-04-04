-- ELLIE-1429: Arc cleanup TTL + goal status history

-- 1. Add expires_at to memory_arcs for TTL-based cleanup
ALTER TABLE memory_arcs ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Index for cleanup queries
CREATE INDEX IF NOT EXISTS idx_memory_arcs_expires
  ON memory_arcs (expires_at)
  WHERE expires_at IS NOT NULL AND archived_at IS NULL;

-- 2. Goal status history table for lifecycle tracking
CREATE TABLE IF NOT EXISTS goal_status_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id   UUID NOT NULL,
  old_status  TEXT,
  new_status  TEXT NOT NULL,
  reason      TEXT,
  changed_by  TEXT,   -- agent or user who triggered the change
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_goal_status_history_memory
  ON goal_status_history (memory_id, created_at DESC);
