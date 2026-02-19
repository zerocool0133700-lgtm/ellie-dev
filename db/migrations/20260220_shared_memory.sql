-- ELLIE-63: Add shared memory columns for cross-agent knowledge sharing
-- Adds source_agent (which agent created the memory) and visibility (private/shared/global)

ALTER TABLE memory
  ADD COLUMN IF NOT EXISTS source_agent TEXT,
  ADD COLUMN IF NOT EXISTS visibility TEXT DEFAULT 'shared'
    CHECK (visibility IN ('private', 'shared', 'global'));

-- Update get_facts to return source_agent
CREATE OR REPLACE FUNCTION get_facts()
RETURNS TABLE (
  id UUID,
  content TEXT,
  source_agent TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.content, m.source_agent
  FROM memory m
  WHERE m.type = 'fact'
  ORDER BY m.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Index for filtering by visibility and source agent
CREATE INDEX IF NOT EXISTS idx_memory_visibility ON memory(visibility);
CREATE INDEX IF NOT EXISTS idx_memory_source_agent ON memory(source_agent);
