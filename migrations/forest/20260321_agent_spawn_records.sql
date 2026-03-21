-- ELLIE-954: Persist spawn registry to DB
-- Spawn records survive relay restarts, enabling timeout enforcement,
-- cost rollup, and orphan recovery across restart boundaries.

CREATE TYPE spawn_state AS ENUM ('pending', 'running', 'completed', 'failed', 'timed_out');

CREATE TABLE agent_spawn_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_session_id TEXT NOT NULL,
  parent_agent_name TEXT NOT NULL,
  child_session_id  TEXT NOT NULL,
  child_session_key TEXT NOT NULL UNIQUE,
  target_agent_name TEXT NOT NULL,
  task              TEXT NOT NULL,
  state             spawn_state NOT NULL DEFAULT 'pending',
  arc_mode          TEXT NOT NULL DEFAULT 'inherit',
  arc_id            UUID,
  delivery_context  JSONB,
  thread_bound      BOOLEAN NOT NULL DEFAULT FALSE,
  work_item_id      TEXT,
  depth             INTEGER NOT NULL DEFAULT 0,
  timeout_seconds   INTEGER NOT NULL DEFAULT 300,
  result_text       TEXT,
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at          TIMESTAMPTZ
);

-- Index for parent lookups (getChildrenForParent)
CREATE INDEX idx_spawn_records_parent ON agent_spawn_records (parent_session_id);

-- Index for active spawn queries (timeout checks, recovery sweep)
CREATE INDEX idx_spawn_records_active ON agent_spawn_records (state) WHERE state IN ('pending', 'running');

-- Index for work item lookups (prompt-builder spawn status)
CREATE INDEX idx_spawn_records_work_item ON agent_spawn_records (work_item_id) WHERE work_item_id IS NOT NULL;

-- Index for GC (prune old completed records)
CREATE INDEX idx_spawn_records_ended ON agent_spawn_records (ended_at) WHERE state NOT IN ('pending', 'running');
