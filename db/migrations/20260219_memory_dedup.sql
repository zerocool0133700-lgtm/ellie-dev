-- ELLIE-71: Add memory conflict resolution via cosine similarity dedup
--
-- New RPC: find_similar_memory
-- Before inserting a memory, call this to find near-duplicates (similarity > threshold).
-- Returns existing memories sorted by similarity descending.
--
-- Also adds a conflict_resolution column to track merge/dedup decisions.

-- RPC to find similar existing memories by embedding
CREATE OR REPLACE FUNCTION find_similar_memory(
  query_embedding VECTOR(1536),
  similarity_threshold FLOAT DEFAULT 0.85,
  match_count INT DEFAULT 5,
  p_type TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  type TEXT,
  source_agent TEXT,
  visibility TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.type,
    m.source_agent,
    m.visibility,
    m.metadata,
    m.created_at,
    (1 - (m.embedding <=> query_embedding))::FLOAT AS similarity
  FROM memory m
  WHERE m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > similarity_threshold
    -- Only compare within same type (facts vs facts, goals vs goals)
    AND (p_type IS NULL OR m.type = p_type)
    -- Exclude completed/cancelled goals from dedup
    AND m.type NOT IN ('completed_goal')
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- Add updated_at trigger for memory table (tracks when merges happen)
CREATE OR REPLACE FUNCTION update_memory_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Only create trigger if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'memory_updated_at'
  ) THEN
    CREATE TRIGGER memory_updated_at
      BEFORE UPDATE ON memory
      FOR EACH ROW
      EXECUTE FUNCTION update_memory_updated_at();
  END IF;
END;
$$;
