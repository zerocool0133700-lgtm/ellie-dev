-- Add safeguard_locked_at column to working_memory table
-- Used by periodic safeguard-auto-unlock task to track locked sessions
ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS safeguard_locked_at TIMESTAMPTZ DEFAULT NULL;
