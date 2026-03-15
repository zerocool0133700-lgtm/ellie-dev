-- Formation Heartbeat Scheduler — ELLIE-723
-- Allow formations to run on a schedule without manual invocation.
-- Agents wake up, check for work, act, report back.

-- ============================================================
-- FORMATION_HEARTBEATS TABLE
-- ============================================================
-- One row per scheduled formation. Tracks cron schedule and run state.
CREATE TABLE IF NOT EXISTS formation_heartbeats (
  formation_slug TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Schedule (standard 5-field cron: min hour dom month dow)
  schedule TEXT NOT NULL,

  -- Which agent facilitates the formation run
  facilitator_agent_id UUID NOT NULL REFERENCES agents(id),

  -- Run tracking
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,

  -- Toggle
  enabled BOOLEAN NOT NULL DEFAULT true,

  -- Optional context passed to formation on each run
  run_context JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_formation_heartbeats_enabled
  ON formation_heartbeats(enabled)
  WHERE enabled = true;

CREATE INDEX IF NOT EXISTS idx_formation_heartbeats_next_run
  ON formation_heartbeats(next_run_at ASC)
  WHERE enabled = true;

-- ============================================================
-- HEARTBEAT_RUNS TABLE (Audit Trail)
-- ============================================================
-- One row per heartbeat execution. Queryable history.
CREATE TABLE IF NOT EXISTS heartbeat_runs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  formation_slug TEXT NOT NULL REFERENCES formation_heartbeats(formation_slug),

  -- Run details
  status TEXT NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'completed', 'failed', 'skipped')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,

  -- Link to the formation session created by this heartbeat
  formation_session_id UUID REFERENCES formation_sessions(id),

  -- Why it was skipped or how it failed
  skip_reason TEXT,
  error TEXT,

  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_heartbeat_runs_slug
  ON heartbeat_runs(formation_slug);

CREATE INDEX IF NOT EXISTS idx_heartbeat_runs_status
  ON heartbeat_runs(status);

CREATE INDEX IF NOT EXISTS idx_heartbeat_runs_started
  ON heartbeat_runs(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_heartbeat_runs_slug_started
  ON heartbeat_runs(formation_slug, started_at DESC);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE formation_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE heartbeat_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON formation_heartbeats FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON heartbeat_runs FOR ALL USING (true);
