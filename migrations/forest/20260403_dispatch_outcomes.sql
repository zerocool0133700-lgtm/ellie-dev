-- Phase 1: Dispatch Observability — outcome storage + stalled event type
-- ELLIE-1309, ELLIE-1310

-- Add 'stalled' to the orchestration_event_type enum
ALTER TYPE orchestration_event_type ADD VALUE IF NOT EXISTS 'stalled';

-- Dispatch outcomes table
CREATE TABLE IF NOT EXISTS dispatch_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id TEXT NOT NULL UNIQUE,
  parent_run_id TEXT,
  agent TEXT NOT NULL,
  work_item_id TEXT,
  dispatch_type TEXT NOT NULL DEFAULT 'single',
  status TEXT NOT NULL,
  summary TEXT,
  files_changed TEXT[] DEFAULT '{}',
  decisions TEXT[] DEFAULT '{}',
  commits TEXT[] DEFAULT '{}',
  forest_writes TEXT[] DEFAULT '{}',
  duration_ms INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd NUMERIC(10,4),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_outcomes_run_id ON dispatch_outcomes(run_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_outcomes_work_item ON dispatch_outcomes(work_item_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_outcomes_created ON dispatch_outcomes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatch_outcomes_parent ON dispatch_outcomes(parent_run_id) WHERE parent_run_id IS NOT NULL;
