-- Scheduled Tasks — ELLIE-975
-- General-purpose user-configurable cron scheduler.
-- Extends formation_heartbeats pattern to any task type.

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Human-readable label shown in dashboard
  name TEXT NOT NULL,
  description TEXT DEFAULT '',

  -- Task type determines what the scheduler invokes
  -- formation: invoke a formation by slug
  -- dispatch:  dispatch work to an agent via orchestration-dispatch
  -- http:      POST to an internal relay endpoint
  -- reminder:  send a notification to Dave
  task_type TEXT NOT NULL CHECK (task_type IN ('formation', 'dispatch', 'http', 'reminder')),

  -- Standard 5-field cron: min hour dom month dow
  schedule TEXT NOT NULL,

  -- Timezone for cron evaluation (default CST)
  timezone TEXT NOT NULL DEFAULT 'America/Chicago',

  -- Enable/disable toggle
  enabled BOOLEAN NOT NULL DEFAULT true,

  -- Type-specific config (formation_slug, agent, endpoint, message, etc.)
  config JSONB NOT NULL DEFAULT '{}',

  -- Run tracking
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  last_status TEXT CHECK (last_status IN ('completed', 'failed', 'skipped') OR last_status IS NULL),
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,

  -- Who created it (null = system-seeded)
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled
  ON scheduled_tasks(enabled) WHERE enabled = true;

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run
  ON scheduled_tasks(next_run_at ASC) WHERE enabled = true;

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_type
  ON scheduled_tasks(task_type);

-- Run history — one row per execution
CREATE TABLE IF NOT EXISTS scheduled_task_runs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  task_id UUID NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'completed', 'failed', 'skipped')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,
  error TEXT,
  result JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task
  ON scheduled_task_runs(task_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_status
  ON scheduled_task_runs(status);
