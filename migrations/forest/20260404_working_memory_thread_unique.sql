-- ELLIE-1427: Enforce thread isolation uniqueness in working_memory
-- Replace old (session_id, agent) constraint with (session_id, agent, thread_id).
-- The old constraint prevents two threads with the same session_id + agent from
-- both having active records. Drop it and create a thread-aware replacement.

-- Drop the old constraint that doesn't account for threads
DROP INDEX IF EXISTS idx_working_memory_active_session;

-- New constraint: one active record per session+agent+thread combination.
-- COALESCE handles NULL thread_id (non-threaded sessions) as a distinct group.
CREATE UNIQUE INDEX idx_working_memory_active_session
  ON working_memory (session_id, agent, COALESCE(thread_id, '__null__'))
  WHERE archived_at IS NULL;
