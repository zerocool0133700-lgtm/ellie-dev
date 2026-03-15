-- Claim Documents — ELLIE-747
-- Normalized FHIR data stored as embedded, searchable documents
-- for RAG retrieval by billing agents.

CREATE TABLE IF NOT EXISTS claim_documents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- FHIR source
  fhir_resource_type TEXT NOT NULL,
  fhir_id TEXT,
  fhir_last_updated TIMESTAMPTZ,

  -- Scoping
  patient_id TEXT,
  encounter_id TEXT,
  company_id UUID REFERENCES companies(id),
  payer_id TEXT,

  -- Content + embedding
  content TEXT NOT NULL,
  embedding vector(1536),

  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived')),

  metadata JSONB DEFAULT '{}'
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_claim_docs_resource_type ON claim_documents(fhir_resource_type);
CREATE INDEX IF NOT EXISTS idx_claim_docs_patient ON claim_documents(patient_id) WHERE patient_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claim_docs_encounter ON claim_documents(encounter_id) WHERE encounter_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claim_docs_company ON claim_documents(company_id) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claim_docs_payer ON claim_documents(payer_id) WHERE payer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claim_docs_fhir_id ON claim_documents(fhir_id) WHERE fhir_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_docs_fhir_dedup ON claim_documents(fhir_id, fhir_resource_type) WHERE fhir_id IS NOT NULL;

-- Semantic search
CREATE INDEX IF NOT EXISTS idx_claim_docs_embedding
  ON claim_documents USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- RLS
ALTER TABLE claim_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON claim_documents FOR ALL USING (true);
