-- ELLIE-1164: Coordinator Heartbeat System

CREATE TABLE IF NOT EXISTS heartbeat_state (
  id TEXT PRIMARY KEY DEFAULT 'singleton',
  enabled BOOLEAN NOT NULL DEFAULT false,
  interval_ms INT NOT NULL DEFAULT 900000,
  active_start TEXT NOT NULL DEFAULT '07:00',
  active_end TEXT NOT NULL DEFAULT '22:00',
  sources TEXT[] NOT NULL DEFAULT '{"email","ci","plane","calendar","forest","gtd"}',
  startup_grace_ms INT NOT NULL DEFAULT 120000,
  min_phase2_interval_ms INT NOT NULL DEFAULT 1800000,
  last_tick_at TIMESTAMPTZ,
  last_phase2_at TIMESTAMPTZ,
  last_snapshot JSONB,
  source_cooldowns JSONB DEFAULT '{}',
  consecutive_skips INT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO heartbeat_state (id) VALUES ('singleton') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS heartbeat_ticks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tick_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  phase_reached INT NOT NULL,
  deltas JSONB,
  actions_taken JSONB,
  cost_usd NUMERIC(8,4) DEFAULT 0,
  duration_ms INT,
  foundation TEXT,
  skipped_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_heartbeat_ticks_at ON heartbeat_ticks(tick_at DESC);
