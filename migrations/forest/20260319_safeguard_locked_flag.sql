-- ELLIE-922: Add safeguard_locked flag to prevent agent updates during verification
--
-- Critical Issue #3: Verification race with agent updates
-- During the compaction safeguard verification window (snapshot → verify → rollback),
-- the agent can continue updating working memory. If rollback then occurs, it would
-- destroy fresh agent data that was written after the snapshot was taken.
--
-- Solution: Add a safeguard_locked flag. When set, updateWorkingMemory rejects updates.
-- Lock is set before snapshot, cleared after verification completes (success or rollback).

ALTER TABLE working_memory
ADD COLUMN IF NOT EXISTS safeguard_locked BOOLEAN NOT NULL DEFAULT FALSE;

-- Index for filtering out locked records when needed
CREATE INDEX IF NOT EXISTS idx_working_memory_safeguard_locked
  ON working_memory (safeguard_locked)
  WHERE safeguard_locked = TRUE;

COMMENT ON COLUMN working_memory.safeguard_locked IS
  'When TRUE, updates are blocked to prevent verification race conditions during compaction safeguard checks (ELLIE-922)';
