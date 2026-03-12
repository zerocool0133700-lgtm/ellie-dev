-- Formation Tables — ELLIE-673
-- Multi-agent coordination sessions and inter-agent messaging.

-- ============================================================
-- FORMATION_SESSIONS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS formation_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  -- Formation Identity
  formation_name TEXT NOT NULL,
  state TEXT DEFAULT 'active' CHECK (state IN ('active', 'paused', 'completed', 'failed', 'timed_out')),
  turn_count INTEGER DEFAULT 0,

  -- Participants
  initiator_agent TEXT NOT NULL,
  participating_agents TEXT[] DEFAULT '{}',
  channel TEXT NOT NULL DEFAULT 'internal',

  -- Context
  work_item_id TEXT,
  protocol JSONB NOT NULL DEFAULT '{}',

  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_formation_sessions_formation_name ON formation_sessions(formation_name);
CREATE INDEX IF NOT EXISTS idx_formation_sessions_state ON formation_sessions(state);
CREATE INDEX IF NOT EXISTS idx_formation_sessions_created_at ON formation_sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_formation_sessions_work_item_id ON formation_sessions(work_item_id);
CREATE INDEX IF NOT EXISTS idx_formation_sessions_initiator ON formation_sessions(initiator_agent);
CREATE INDEX IF NOT EXISTS idx_formation_sessions_active ON formation_sessions(state)
  WHERE state = 'active';

-- ============================================================
-- FORMATION_MESSAGES TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS formation_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  session_id UUID NOT NULL REFERENCES formation_sessions(id) ON DELETE CASCADE,

  -- Message Details
  from_agent TEXT NOT NULL,
  to_agent TEXT,
  content TEXT NOT NULL,
  turn_number INTEGER NOT NULL DEFAULT 0,
  message_type TEXT DEFAULT 'response' CHECK (message_type IN ('proposal', 'response', 'decision', 'escalation', 'system')),

  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_formation_messages_session_id ON formation_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_formation_messages_from_agent ON formation_messages(from_agent);
CREATE INDEX IF NOT EXISTS idx_formation_messages_created_at ON formation_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_formation_messages_turn ON formation_messages(session_id, turn_number);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE formation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE formation_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON formation_sessions FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON formation_messages FOR ALL USING (true);
