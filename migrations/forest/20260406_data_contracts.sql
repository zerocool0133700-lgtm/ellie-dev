-- ELLIE-1474: Data contract schema — 8-table structured document storage layer
-- Contracts define the shape, documents hold the data, history tables track revisions,
-- reference tables externalize JSON relationships for fast querying.

-- ============================================================================
-- 1. data_contracts — Current version of each contract
-- ============================================================================
CREATE TABLE IF NOT EXISTS data_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_path TEXT NOT NULL,                        -- Forest scope (e.g. '2/5')
  name TEXT NOT NULL,                              -- Contract name (e.g. 'ellie-learn')
  revision INT NOT NULL DEFAULT 1 CHECK (revision > 0),
  schema JSONB NOT NULL DEFAULT '{}',              -- The contract shape definition
  anchor_values JSONB NOT NULL DEFAULT '{}',       -- Minimum required fields that form the contract
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(scope_path, name)
);

CREATE INDEX IF NOT EXISTS idx_data_contracts_scope_path ON data_contracts(scope_path);
CREATE INDEX IF NOT EXISTS idx_data_contracts_name ON data_contracts(name);

-- ============================================================================
-- 2. data_contract_history — Full revision history of contracts
-- ============================================================================
CREATE TABLE IF NOT EXISTS data_contract_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES data_contracts(id) ON DELETE CASCADE,
  scope_path TEXT NOT NULL,
  name TEXT NOT NULL,
  revision INT NOT NULL CHECK (revision > 0),
  schema JSONB NOT NULL DEFAULT '{}',
  anchor_values JSONB NOT NULL DEFAULT '{}',
  description TEXT,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_contract_history_contract ON data_contract_history(contract_id);
CREATE INDEX IF NOT EXISTS idx_data_contract_history_scope_path ON data_contract_history(scope_path);
CREATE INDEX IF NOT EXISTS idx_data_contract_history_revision ON data_contract_history(contract_id, revision);

-- ============================================================================
-- 3. data_documents — Document instances stored against a contract
-- ============================================================================
CREATE TABLE IF NOT EXISTS data_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES data_contracts(id) ON DELETE CASCADE,
  scope_path TEXT NOT NULL,                        -- May differ from contract scope (child scopes)
  document JSONB NOT NULL DEFAULT '{}',            -- The actual document data
  revision INT NOT NULL DEFAULT 1 CHECK (revision > 0),
  contract_revision INT NOT NULL DEFAULT 1 CHECK (contract_revision > 0),  -- Which contract rev this doc was written against
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_documents_contract ON data_documents(contract_id);
CREATE INDEX IF NOT EXISTS idx_data_documents_scope_path ON data_documents(scope_path);
CREATE INDEX IF NOT EXISTS idx_data_documents_contract_scope ON data_documents(contract_id, scope_path);

-- ============================================================================
-- 4. data_document_history — Full revision history of documents
-- ============================================================================
CREATE TABLE IF NOT EXISTS data_document_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES data_documents(id) ON DELETE CASCADE,
  contract_id UUID NOT NULL REFERENCES data_contracts(id) ON DELETE CASCADE,
  scope_path TEXT NOT NULL,
  document JSONB NOT NULL DEFAULT '{}',
  revision INT NOT NULL CHECK (revision > 0),
  contract_revision INT NOT NULL DEFAULT 1 CHECK (contract_revision > 0),
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_document_history_document ON data_document_history(document_id);
CREATE INDEX IF NOT EXISTS idx_data_document_history_contract ON data_document_history(contract_id);
CREATE INDEX IF NOT EXISTS idx_data_document_history_scope_path ON data_document_history(scope_path);
CREATE INDEX IF NOT EXISTS idx_data_document_history_revision ON data_document_history(document_id, revision);

-- ============================================================================
-- 5. data_contract_refs — Extracted references from contract schemas
-- ============================================================================
CREATE TABLE IF NOT EXISTS data_contract_refs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES data_contracts(id) ON DELETE CASCADE,
  ref_type TEXT NOT NULL,                          -- e.g. 'dependency', 'scope', 'entity'
  ref_key TEXT NOT NULL,                           -- e.g. 'ellie-forest', 'tree_type'
  ref_value TEXT,                                  -- e.g. 'learning', '2/5'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_contract_refs_contract ON data_contract_refs(contract_id);
CREATE INDEX IF NOT EXISTS idx_data_contract_refs_type_key ON data_contract_refs(ref_type, ref_key);
CREATE INDEX IF NOT EXISTS idx_data_contract_refs_type ON data_contract_refs(ref_type);

-- ============================================================================
-- 6. data_contract_ref_history — History of contract refs
-- ============================================================================
CREATE TABLE IF NOT EXISTS data_contract_ref_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_ref_id UUID NOT NULL REFERENCES data_contract_refs(id) ON DELETE CASCADE,
  contract_id UUID NOT NULL REFERENCES data_contracts(id) ON DELETE CASCADE,
  ref_type TEXT NOT NULL,
  ref_key TEXT NOT NULL,
  ref_value TEXT,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_contract_ref_history_ref ON data_contract_ref_history(contract_ref_id);
CREATE INDEX IF NOT EXISTS idx_data_contract_ref_history_contract ON data_contract_ref_history(contract_id);
CREATE INDEX IF NOT EXISTS idx_data_contract_ref_history_type_key ON data_contract_ref_history(ref_type, ref_key);

-- ============================================================================
-- 7. data_document_refs — Extracted references from documents
-- ============================================================================
CREATE TABLE IF NOT EXISTS data_document_refs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES data_documents(id) ON DELETE CASCADE,
  ref_type TEXT NOT NULL,                          -- e.g. 'learner', 'creature', 'session'
  ref_key TEXT NOT NULL,                           -- e.g. 'learner_id', 'creature_name'
  ref_value TEXT,                                  -- e.g. UUID or name value
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_document_refs_document ON data_document_refs(document_id);
CREATE INDEX IF NOT EXISTS idx_data_document_refs_type_key ON data_document_refs(ref_type, ref_key);
CREATE INDEX IF NOT EXISTS idx_data_document_refs_type ON data_document_refs(ref_type);

-- ============================================================================
-- 8. data_document_ref_history — History of document refs
-- ============================================================================
CREATE TABLE IF NOT EXISTS data_document_ref_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_ref_id UUID NOT NULL REFERENCES data_document_refs(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES data_documents(id) ON DELETE CASCADE,
  ref_type TEXT NOT NULL,
  ref_key TEXT NOT NULL,
  ref_value TEXT,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_document_ref_history_ref ON data_document_ref_history(document_ref_id);
CREATE INDEX IF NOT EXISTS idx_data_document_ref_history_document ON data_document_ref_history(document_id);
CREATE INDEX IF NOT EXISTS idx_data_document_ref_history_type_key ON data_document_ref_history(ref_type, ref_key);
