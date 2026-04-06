-- ELLIE-1459: Add source_thread_id to dispatch_outcomes for thread routing audit
-- Tracks which thread originated a dispatch so responses can be correlated.

ALTER TABLE dispatch_outcomes
  ADD COLUMN IF NOT EXISTS source_thread_id TEXT;

CREATE INDEX IF NOT EXISTS idx_dispatch_outcomes_source_thread
  ON dispatch_outcomes(source_thread_id)
  WHERE source_thread_id IS NOT NULL;
