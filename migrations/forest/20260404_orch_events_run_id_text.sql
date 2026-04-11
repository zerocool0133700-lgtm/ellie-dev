-- 20260404_orch_events_run_id_text.sql
-- Fix dispatch event UUID mismatch: run_id was uuid but coordinator passes
-- dsp_* envelope IDs (base36 nanoid). Change to text to accept both formats.

-- Drop indexes that depend on run_id
DROP INDEX IF EXISTS idx_orch_events_run_id;

-- Alter column type
ALTER TABLE orchestration_events
  ALTER COLUMN run_id TYPE text USING run_id::text;

-- Recreate index
CREATE INDEX idx_orch_events_run_id ON orchestration_events(run_id);
