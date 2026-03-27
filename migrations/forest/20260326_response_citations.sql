-- ELLIE-1046: Citation tracking for agent responses
-- Records which memories an agent used when generating a response

CREATE TABLE IF NOT EXISTS response_citations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  response_id TEXT NOT NULL,           -- dispatch/conversation ID
  memory_id UUID NOT NULL REFERENCES shared_memories(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,                 -- which creature cited this
  relevance_score FLOAT DEFAULT 0.5,  -- how relevant the citation was
  chunk_excerpt TEXT,                  -- specific excerpt used (optional)
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_citations_response ON response_citations(response_id);
CREATE INDEX idx_citations_memory ON response_citations(memory_id);
CREATE INDEX idx_citations_agent ON response_citations(agent);

-- View: most-cited memories (for importance scoring)
CREATE OR REPLACE VIEW memory_citation_counts AS
SELECT
  memory_id,
  count(*) as citation_count,
  count(DISTINCT agent) as citing_agents,
  max(created_at) as last_cited_at
FROM response_citations
GROUP BY memory_id;
