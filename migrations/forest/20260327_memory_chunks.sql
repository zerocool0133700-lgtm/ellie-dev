-- ELLIE-1050: Chunked embeddings for fine-grained memory search
CREATE TABLE IF NOT EXISTS memory_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL REFERENCES shared_memories(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(1536),
  token_count INT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(memory_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_memory_chunks_memory ON memory_chunks(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_embedding ON memory_chunks USING hnsw (embedding vector_cosine_ops);
