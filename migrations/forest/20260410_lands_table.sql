-- ELLIE-1541: Dedicated table for land scope type
-- Land is the top-level property/site entity in the Forest. Each land owns
-- trees (properties), has its own scope hierarchy, and is the anchor for
-- the land data contract. The lands table is the SQL source of truth.

CREATE TABLE IF NOT EXISTS lands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,

  -- Scope linkage — each land has a corresponding knowledge_scope
  scope_id UUID REFERENCES knowledge_scopes(id) ON DELETE RESTRICT,

  -- Contract linkage — the land data contract this land was created under
  land_contract_id UUID REFERENCES data_contracts(id) ON DELETE RESTRICT,

  -- Owner — who controls this land (FK to rbac_entities)
  owner_id UUID NOT NULL REFERENCES rbac_entities(id) ON DELETE RESTRICT,

  -- Contract info (from the land contract schema)
  contract_date DATE,
  effective_date DATE,

  -- Status
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),

  -- Metadata
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (name)
);

CREATE INDEX IF NOT EXISTS idx_lands_scope_id ON lands(scope_id);
CREATE INDEX IF NOT EXISTS idx_lands_owner_id ON lands(owner_id);
CREATE INDEX IF NOT EXISTS idx_lands_status ON lands(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_lands_contract ON lands(land_contract_id) WHERE land_contract_id IS NOT NULL;

-- Updated_at trigger
DROP TRIGGER IF EXISTS trg_set_updated_at_lands ON lands;
CREATE TRIGGER trg_set_updated_at_lands
  BEFORE UPDATE ON lands
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Link knowledge_scopes to lands (optional FK for land-level scopes)
ALTER TABLE knowledge_scopes ADD COLUMN IF NOT EXISTS land_id UUID REFERENCES lands(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_knowledge_scopes_land_id ON knowledge_scopes(land_id) WHERE land_id IS NOT NULL;
