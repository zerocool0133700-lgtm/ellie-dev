-- ELLIE-1164: Add dry_run column to heartbeat_state
-- When true, Phase 2 runs but messages are logged instead of delivered.
ALTER TABLE heartbeat_state ADD COLUMN IF NOT EXISTS dry_run BOOLEAN NOT NULL DEFAULT true;
