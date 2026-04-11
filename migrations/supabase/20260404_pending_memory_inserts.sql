-- ELLIE-1419: Persist pending memory dedup queue to survive relay restarts
--
-- Previously, memory inserts queued when the search Edge Function was down
-- lived only in an in-memory array (_pendingMemoryQueue). A relay crash
-- would permanently lose those items.
--
-- This table replaces the in-memory queue with a durable Supabase-backed store.
-- Items are written here when dedup search is unavailable, and drained on startup
-- via flushPendingMemoryInserts().

CREATE TABLE IF NOT EXISTS pending_memory_inserts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Idempotency: SHA-256 of (type + content + source_agent) prevents duplicate queue entries
  idempotency_key TEXT NOT NULL UNIQUE,

  -- MemoryInsertParams fields
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  source_agent TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'shared', 'global')),
  deadline TEXT,
  conversation_id TEXT,
  metadata JSONB DEFAULT '{}',

  -- Retry tracking
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  error_message TEXT
);

-- Drain query: oldest first, limited retries
CREATE INDEX IF NOT EXISTS idx_pending_memory_created
  ON pending_memory_inserts (created_at ASC);

-- Idempotency lookups (covered by UNIQUE constraint, but explicit for clarity)
-- The UNIQUE constraint on idempotency_key already creates an index.
