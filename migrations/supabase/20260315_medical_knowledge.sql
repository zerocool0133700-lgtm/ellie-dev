-- Medical Knowledge Table — ELLIE-736
-- Domain-specific medical billing reference data with pgvector embeddings.
-- Separate from conversational memory — this is static reference data.

-- ============================================================
-- ENABLE PGVECTOR (idempotent)
-- ============================================================
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- MEDICAL_KNOWLEDGE TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS medical_knowledge (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Classification
  category TEXT NOT NULL CHECK (category IN (
    'cpt_codes', 'icd10_codes', 'payer_rules', 'denial_reasons',
    'appeal_templates', 'compliance', 'fee_schedules'
  )),
  subcategory TEXT,

  -- Content
  content TEXT NOT NULL,

  -- Embedding for semantic search (OpenAI text-embedding-3-small dimension)
  embedding vector(1536),

  -- Provenance
  source_doc TEXT,
  effective_date DATE,

  -- Scoping
  payer_id TEXT,
  company_id UUID REFERENCES companies(id),

  metadata JSONB DEFAULT '{}'
);

-- ============================================================
-- INDEXES
-- ============================================================

-- Category lookups
CREATE INDEX IF NOT EXISTS idx_medical_knowledge_category
  ON medical_knowledge(category);

-- Payer-specific lookups
CREATE INDEX IF NOT EXISTS idx_medical_knowledge_payer
  ON medical_knowledge(payer_id)
  WHERE payer_id IS NOT NULL;

-- Company scoping
CREATE INDEX IF NOT EXISTS idx_medical_knowledge_company
  ON medical_knowledge(company_id)
  WHERE company_id IS NOT NULL;

-- Composite: category + company (most common query pattern)
CREATE INDEX IF NOT EXISTS idx_medical_knowledge_category_company
  ON medical_knowledge(category, company_id);

-- Effective date for temporal queries (latest rules)
CREATE INDEX IF NOT EXISTS idx_medical_knowledge_effective
  ON medical_knowledge(effective_date DESC)
  WHERE effective_date IS NOT NULL;

-- Semantic search via pgvector (IVFFlat for approximate nearest neighbor)
-- NOTE: IVFFlat requires rows to exist before building the index.
-- For initial load, create after seeding data. For incremental use,
-- this index works but may need periodic REINDEX.
CREATE INDEX IF NOT EXISTS idx_medical_knowledge_embedding
  ON medical_knowledge USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE medical_knowledge ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON medical_knowledge FOR ALL USING (true);
