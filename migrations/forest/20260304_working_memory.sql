-- ELLIE-538: Working memory — session-scoped state layer
--
-- Adds a working_memory table to the Forest DB. This layer sits between
-- the ephemeral context window and permanent Forest/Supabase storage,
-- surviving context compression and making every session resumable.
--
-- 7 sections stored as JSONB keys:
--   session_identity    — agent name, ticket ID, channel
--   task_stack          — ordered todo list with active task highlighted
--   conversation_thread — narrative summary (not transcript)
--   investigation_state — hypotheses, files read, current exploration
--   decision_log        — choices made this session with reasoning
--   context_anchors     — specific details that must survive (errors, line numbers, values)
--   resumption_prompt   — agent-written continuation note for its future self
--
-- Lifecycle:
--   - One active record per (session_id, agent) pair at a time
--   - Auto-archived after 24h idle (by archiveIdleWorkingMemory())
--   - Max 10 active sessions kept per agent (oldest pruned on init)

CREATE TABLE IF NOT EXISTS working_memory (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  TEXT        NOT NULL,                     -- work item ID or session UUID
  agent       TEXT        NOT NULL,                     -- agent name (dev, research, strategy, general)
  sections    JSONB       NOT NULL DEFAULT '{}',        -- the 7 section fields
  turn_number INTEGER     NOT NULL DEFAULT 0,           -- incremented on each update/checkpoint
  channel     TEXT,                                     -- telegram, google-chat, ellie-chat
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ                               -- NULL = active, timestamp = archived
);

-- Enforce one active record per session+agent combination
CREATE UNIQUE INDEX IF NOT EXISTS idx_working_memory_active_session
  ON working_memory (session_id, agent)
  WHERE archived_at IS NULL;

-- Fast lookups by session
CREATE INDEX IF NOT EXISTS idx_working_memory_session_id
  ON working_memory (session_id);

-- Used by idle-archive cron (only scans active records)
CREATE INDEX IF NOT EXISTS idx_working_memory_active_updated
  ON working_memory (updated_at)
  WHERE archived_at IS NULL;

-- General ordering / analytics
CREATE INDEX IF NOT EXISTS idx_working_memory_updated_at
  ON working_memory (updated_at);
