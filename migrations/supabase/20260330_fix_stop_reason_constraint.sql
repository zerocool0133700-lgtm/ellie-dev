-- ELLIE-1156: Add missing 'relay_restart' to stop_reason CHECK constraint
-- The init module writes relay_restart when stopping stale sessions on startup,
-- but the original constraint didn't include it.

ALTER TABLE overnight_sessions
  DROP CONSTRAINT IF EXISTS overnight_sessions_stop_reason_check;

ALTER TABLE overnight_sessions
  ADD CONSTRAINT overnight_sessions_stop_reason_check
    CHECK (stop_reason IN ('time_limit', 'user_activity', 'manual', 'all_done', 'relay_restart'));
