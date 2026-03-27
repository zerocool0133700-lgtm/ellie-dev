-- ELLIE-1044: Semantic edges between Forest memories
-- Auto-computed cosine similarity links for knowledge graph

CREATE TABLE IF NOT EXISTS semantic_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_memory_id UUID NOT NULL REFERENCES shared_memories(id) ON DELETE CASCADE,
  target_memory_id UUID NOT NULL REFERENCES shared_memories(id) ON DELETE CASCADE,
  similarity FLOAT NOT NULL CHECK (similarity >= 0 AND similarity <= 1),
  edge_type TEXT NOT NULL DEFAULT 'similar' CHECK (edge_type IN ('similar', 'refines', 'contradicts', 'elaborates', 'cites')),
  computed_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}',
  UNIQUE(source_memory_id, target_memory_id, edge_type),
  CHECK(source_memory_id != target_memory_id)
);

CREATE INDEX idx_semantic_edges_source ON semantic_edges(source_memory_id);
CREATE INDEX idx_semantic_edges_target ON semantic_edges(target_memory_id);
CREATE INDEX idx_semantic_edges_similarity ON semantic_edges(similarity DESC);
CREATE INDEX idx_semantic_edges_type ON semantic_edges(edge_type);
