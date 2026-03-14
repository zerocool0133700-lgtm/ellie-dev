-- ELLIE-715: Progress checkpoint support for work sessions
--
-- Adds time-estimate and checkpoint config to work_sessions,
-- and adds 'checkpoint' as a valid update_type for work_session_updates.
--
-- Checkpoints fire at configurable time intervals (default 25/50/75%)
-- and store a status snapshot (done/next/blockers) extracted from working memory.
--
-- DATA MODEL:
--   work_sessions.estimated_duration_minutes → How long the task is expected to take (used to calculate checkpoint times)
--   work_sessions.checkpoint_config → JSONB: {"enabled": boolean, "intervals": [25, 50, 75]}
--   work_session_updates with update_type='checkpoint' → Stores CheckpointReport in details JSONB
--
-- CheckpointReport structure (stored in work_session_updates.details):
--   {
--     "percent": 25,                          -- Which checkpoint (25/50/75)
--     "elapsed_minutes": 15,                  -- Time elapsed since session start
--     "estimated_total_minutes": 60,          -- Total estimated duration
--     "done": "Completed schema design...",   -- What's been accomplished
--     "next": "Next: implement timing core...", -- What's planned next
--     "blockers": "",                         -- Any blockers (empty if none)
--     "turn_count": 12                        -- Optional: agent turn count
--   }
--
-- See src/checkpoint-types.ts for TypeScript interfaces.

-- 1. Add estimated duration and checkpoint config to work_sessions
ALTER TABLE work_sessions
  ADD COLUMN IF NOT EXISTS estimated_duration_minutes INTEGER,
  ADD COLUMN IF NOT EXISTS checkpoint_config JSONB
    DEFAULT '{"enabled": true, "intervals": [25, 50, 75]}';

-- 2. Expand type constraint to include 'checkpoint'
-- Drop the existing constraint if it exists
ALTER TABLE work_session_updates
  DROP CONSTRAINT IF EXISTS work_session_updates_type_check;

-- Add the new constraint with 'checkpoint' included
ALTER TABLE work_session_updates
  ADD CONSTRAINT work_session_updates_type_check
  CHECK (type IN ('progress', 'decision', 'milestone', 'blocker', 'checkpoint'));
