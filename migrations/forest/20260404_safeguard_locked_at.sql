-- ELLIE-1420: Add safeguard_locked_at timestamp for deadlock prevention
--
-- The safeguard_locked flag blocks working memory updates during compaction
-- verification. If the verification process crashes, the session stays
-- permanently locked. Adding a timestamp lets an hourly cron auto-unlock
-- locks older than 1 hour.

ALTER TABLE working_memory
ADD COLUMN IF NOT EXISTS safeguard_locked_at TIMESTAMPTZ;

COMMENT ON COLUMN working_memory.safeguard_locked_at IS
  'When safeguard_locked was set to TRUE. Used by auto-unlock cron to clear stale locks older than 1 hour (ELLIE-1420)';

-- Index for the auto-unlock query: find locked records with stale timestamps
CREATE INDEX IF NOT EXISTS idx_working_memory_stale_safeguard
  ON working_memory (safeguard_locked_at)
  WHERE safeguard_locked = TRUE AND archived_at IS NULL;
