-- ELLIE-1427: Enforce thread isolation uniqueness in working_memory
-- Ensures only one active (non-archived) record per session+agent+thread combination.
-- Uses a partial unique index since (session_id, agent, thread_id) alone would conflict
-- with archived records.
CREATE UNIQUE INDEX IF NOT EXISTS idx_working_memory_session_agent_thread_active
  ON working_memory (session_id, agent, COALESCE(thread_id, '__null__'))
  WHERE archived_at IS NULL;
