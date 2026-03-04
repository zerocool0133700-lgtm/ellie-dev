-- ELLIE-323: Memory Module — conversation_facts + memory_conflicts tables
--
-- conversation_facts: Structured personal knowledge store (facts, preferences, goals,
-- decisions, constraints, contacts) extracted from conversations.
-- Replaces the unstructured memory table for the memory module while
-- keeping backward compat (memory table stays for legacy processMemoryIntents).
--
-- memory_conflicts: Tracks detected conflicts between facts for user resolution.

-- ── conversation_facts ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS conversation_facts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Content
  content TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'fact', 'preference', 'goal', 'completed_goal',
    'decision', 'constraint', 'contact'
  )),
  category TEXT CHECK (category IN (
    'personal', 'work', 'people', 'schedule', 'technical', 'other'
  )),

  -- Confidence & provenance
  confidence FLOAT NOT NULL DEFAULT 0.7
    CHECK (confidence >= 0 AND confidence <= 1),
  source_channel TEXT,                    -- telegram, gchat, voice, manual
  source_message_id UUID,                -- ref to unified_messages.id
  extraction_method TEXT NOT NULL DEFAULT 'pattern'
    CHECK (extraction_method IN ('tag', 'pattern', 'ai', 'manual')),

  -- Status & lifecycle
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'superseded', 'needs_review')),
  superseded_by UUID REFERENCES conversation_facts(id),
  archived_at TIMESTAMPTZ,

  -- Goal-specific fields
  deadline TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,

  -- Tags for categorization
  tags TEXT[] DEFAULT '{}',

  -- Forest sync tracking
  forest_memory_id TEXT,                 -- ID in shared_memories if synced
  forest_synced_at TIMESTAMPTZ,

  -- Embedding for semantic similarity search
  embedding VECTOR(1536),

  -- Flexible metadata
  metadata JSONB DEFAULT '{}'
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_cf_type_status ON conversation_facts(type, status);
CREATE INDEX IF NOT EXISTS idx_cf_status ON conversation_facts(status);
CREATE INDEX IF NOT EXISTS idx_cf_category ON conversation_facts(category);
CREATE INDEX IF NOT EXISTS idx_cf_created_at ON conversation_facts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cf_source_channel ON conversation_facts(source_channel);
CREATE INDEX IF NOT EXISTS idx_cf_tags ON conversation_facts USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_cf_deadline ON conversation_facts(deadline)
  WHERE type = 'goal' AND status = 'active' AND deadline IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cf_forest_sync ON conversation_facts(forest_synced_at)
  WHERE forest_memory_id IS NULL AND status = 'active';

-- Embedding similarity search
CREATE INDEX IF NOT EXISTS idx_cf_embedding ON conversation_facts
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_cf_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'cf_updated_at'
  ) THEN
    CREATE TRIGGER cf_updated_at
      BEFORE UPDATE ON conversation_facts
      FOR EACH ROW
      EXECUTE FUNCTION update_cf_updated_at();
  END IF;
END;
$$;

-- ── memory_conflicts ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS memory_conflicts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,

  -- The two conflicting facts
  fact_a_id UUID NOT NULL REFERENCES conversation_facts(id),
  fact_b_id UUID NOT NULL REFERENCES conversation_facts(id),

  -- Analysis
  similarity FLOAT NOT NULL,
  conflict_type TEXT NOT NULL CHECK (conflict_type IN (
    'update', 'clarification', 'contradiction'
  )),

  -- Resolution
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolution TEXT CHECK (resolution IN (
    'keep_a', 'keep_b', 'merge', 'keep_both', 'dismissed'
  )),
  resolved_content TEXT,               -- merged content if resolution = 'merge'
  resolved_by TEXT,                    -- 'auto', 'user', 'ai'

  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_mc_status ON memory_conflicts(status);
CREATE INDEX IF NOT EXISTS idx_mc_fact_a ON memory_conflicts(fact_a_id);
CREATE INDEX IF NOT EXISTS idx_mc_fact_b ON memory_conflicts(fact_b_id);

-- ── Helper: find similar conversation facts ───────────────────

CREATE OR REPLACE FUNCTION find_similar_facts(
  query_embedding VECTOR(1536),
  similarity_threshold FLOAT DEFAULT 0.85,
  match_count INT DEFAULT 5,
  p_type TEXT DEFAULT NULL,
  p_status TEXT DEFAULT 'active'
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  type TEXT,
  category TEXT,
  confidence FLOAT,
  tags TEXT[],
  created_at TIMESTAMPTZ,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    cf.id,
    cf.content,
    cf.type,
    cf.category,
    cf.confidence::FLOAT,
    cf.tags,
    cf.created_at,
    (1 - (cf.embedding <=> query_embedding))::FLOAT AS similarity
  FROM conversation_facts cf
  WHERE cf.embedding IS NOT NULL
    AND cf.status = p_status
    AND 1 - (cf.embedding <=> query_embedding) > similarity_threshold
    AND (p_type IS NULL OR cf.type = p_type)
    AND cf.type NOT IN ('completed_goal')
  ORDER BY cf.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- ── Helper: get overdue goals ─────────────────────────────────

CREATE OR REPLACE FUNCTION get_overdue_goals()
RETURNS TABLE (
  id UUID,
  content TEXT,
  deadline TIMESTAMPTZ,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT cf.id, cf.content, cf.deadline, cf.created_at
  FROM conversation_facts cf
  WHERE cf.type = 'goal'
    AND cf.status = 'active'
    AND cf.deadline IS NOT NULL
    AND cf.deadline < NOW()
  ORDER BY cf.deadline ASC;
END;
$$ LANGUAGE plpgsql;
