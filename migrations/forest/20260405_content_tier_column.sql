-- ELLIE-1428: Add content tier classification for weight differentiation
-- content_tier: foundational (identity/values), strategic (decisions/preferences),
--               operational (technical facts), ephemeral (bugs/incidents)

ALTER TABLE shared_memories
  ADD COLUMN IF NOT EXISTS content_tier TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS needs_deep_classification BOOLEAN DEFAULT false;

-- Index for the periodic deep classification task
CREATE INDEX IF NOT EXISTS idx_shared_memories_needs_deep
  ON shared_memories (needs_deep_classification)
  WHERE needs_deep_classification = true;

COMMENT ON COLUMN shared_memories.content_tier IS 'Content importance tier: foundational, strategic, operational, ephemeral';
COMMENT ON COLUMN shared_memories.needs_deep_classification IS 'Flag for async LLM classification of ambiguous content';
