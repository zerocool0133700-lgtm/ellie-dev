-- ============================================================
-- Create shared_memories table for Forest Bridge
-- ============================================================
-- Consolidated from ellie-forest migrations 005, 009, 011, 015,
-- 020, 025, 028, 030, 031, 032. FK constraints to missing tables
-- (trees, branches, entities, creatures, commits) are deferred
-- until those tables are created.
-- ============================================================

-- Enums
DO $$ BEGIN
  CREATE TYPE memory_scope AS ENUM ('global', 'forest', 'tree', 'branch');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE memory_type AS ENUM (
    'fact', 'decision', 'preference', 'finding',
    'hypothesis', 'contradiction', 'summary'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Main table
CREATE TABLE IF NOT EXISTS shared_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID,

  -- Content
  content TEXT NOT NULL,
  type memory_type NOT NULL DEFAULT 'fact',

  -- Scope hierarchy
  scope memory_scope NOT NULL DEFAULT 'tree',
  scope_id UUID,
  scope_path TEXT,

  -- Attribution (no FK constraints — referenced tables may not exist yet)
  source_entity_id UUID,
  source_creature_id UUID,
  source_commit_id UUID,
  source_tree_id UUID,

  -- Confidence
  confidence FLOAT NOT NULL DEFAULT 0.5
    CHECK (confidence >= 0.0 AND confidence <= 1.0),

  -- Contradiction tracking
  supersedes_id UUID REFERENCES shared_memories(id),
  superseded_by_id UUID REFERENCES shared_memories(id),
  contradiction_resolved BOOLEAN DEFAULT FALSE,

  -- Semantic search
  embedding vector(1536),

  -- Metadata
  tags TEXT[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}',

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,

  -- From 009-memory-architecture-redesign
  cognitive_type cognitive_type,
  duration memory_duration NOT NULL DEFAULT 'long_term',
  status memory_status NOT NULL DEFAULT 'active',
  category memory_category NOT NULL DEFAULT 'general',
  emotional_valence FLOAT CHECK (emotional_valence >= -1.0 AND emotional_valence <= 1.0),
  emotional_intensity FLOAT CHECK (emotional_intensity >= 0.0 AND emotional_intensity <= 1.0),
  expires_at TIMESTAMPTZ,
  weight FLOAT CHECK (weight >= 0.0 AND weight <= 1.0),
  access_count INT NOT NULL DEFAULT 0,
  last_accessed_at TIMESTAMPTZ,

  -- From 015-cross-agent-memory
  source_agent_species TEXT,
  shareable BOOLEAN NOT NULL DEFAULT TRUE,

  -- From 028-capability-trees
  alternatives_considered JSONB,

  -- From 030-memory-tiers
  memory_tier memory_tier NOT NULL DEFAULT 'extended',
  goal_status TEXT,
  goal_deadline TIMESTAMPTZ,
  goal_progress FLOAT CHECK (goal_progress >= 0.0 AND goal_progress <= 1.0),
  completion_criteria TEXT,

  -- From 031-hybrid-search-bm25
  content_tsvector TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,

  -- From 032-importance-score
  importance_score FLOAT DEFAULT 0.5
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_shared_memories_scope ON shared_memories (scope, scope_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_shared_memories_scope_path ON shared_memories (scope_path) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_shared_memories_scope_path_created ON shared_memories (scope_path, created_at DESC) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_shared_memories_owner ON shared_memories (owner_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_shared_memories_source_tree ON shared_memories (source_tree_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_shared_memories_tree_created ON shared_memories (source_tree_id, created_at DESC) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_shared_memories_source_entity ON shared_memories (source_entity_id) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_shared_memories_unresolved_contradictions ON shared_memories (scope, scope_id) WHERE contradiction_resolved = FALSE AND type = 'contradiction';
CREATE INDEX IF NOT EXISTS idx_shared_memories_type_confidence ON shared_memories (type, confidence DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_shared_memories_status ON shared_memories (status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_shared_memories_category ON shared_memories (category) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_shared_memories_cognitive ON shared_memories (cognitive_type) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_shared_memories_expires ON shared_memories (expires_at) WHERE expires_at IS NOT NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_shared_memories_weight ON shared_memories (weight DESC NULLS LAST) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_shared_memories_shareable ON shared_memories (source_tree_id, shareable) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_shared_memories_tier ON shared_memories (memory_tier) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_shared_memories_active_goals ON shared_memories (memory_tier, goal_status) WHERE memory_tier = 'goals' AND goal_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shared_memories_goal_deadline ON shared_memories (goal_deadline) WHERE memory_tier = 'goals' AND goal_deadline IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shared_memories_importance ON shared_memories (importance_score DESC) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_shared_memories_embedding ON shared_memories USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_shared_memories_content_tsvector ON shared_memories USING gin (content_tsvector);
CREATE INDEX IF NOT EXISTS idx_shared_memories_alternatives_gin ON shared_memories USING gin (alternatives_considered) WHERE alternatives_considered IS NOT NULL;

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_shared_memories_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_shared_memories_updated_at ON shared_memories;
CREATE TRIGGER trg_shared_memories_updated_at
  BEFORE UPDATE ON shared_memories
  FOR EACH ROW EXECUTE FUNCTION update_shared_memories_updated_at();
