-- ELLIE-800: Capture session persistence table
-- Stores in-flight capture session state for recovery across session boundaries.

CREATE TABLE IF NOT EXISTS capture_session_state (
  session_id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'idle' CHECK (mode IN ('brain_dump', 'review', 'template', 'idle')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  items_in_flight JSONB DEFAULT '[]',
  current_index INT NOT NULL DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_capture_session_agent ON capture_session_state(agent);
CREATE INDEX IF NOT EXISTS idx_capture_session_mode ON capture_session_state(mode) WHERE mode != 'idle';

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_capture_session_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_capture_session_updated_at ON capture_session_state;
CREATE TRIGGER trg_capture_session_updated_at
  BEFORE UPDATE ON capture_session_state
  FOR EACH ROW EXECUTE FUNCTION update_capture_session_updated_at();
