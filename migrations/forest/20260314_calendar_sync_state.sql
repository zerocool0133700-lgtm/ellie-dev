-- Calendar sync state: tracks which events we expect to see each sync cycle.
-- Events missing from 2+ consecutive syncs are flagged as deleted.

CREATE TABLE IF NOT EXISTS calendar_sync_state (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'outlook', 'apple')),
  calendar_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consecutive_misses INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (provider, calendar_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_sync_state_provider
  ON calendar_sync_state(provider);

CREATE INDEX IF NOT EXISTS idx_calendar_sync_state_misses
  ON calendar_sync_state(consecutive_misses)
  WHERE consecutive_misses >= 2;

-- Add deleted_at to calendar_events if not present
ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
