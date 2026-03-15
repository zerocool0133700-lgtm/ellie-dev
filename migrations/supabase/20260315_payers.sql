-- Payer Registry — ELLIE-739
-- Payer-specific knowledge filtering for medical billing.

-- ============================================================
-- PAYERS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS payers (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('commercial', 'medicare', 'medicaid', 'tricare', 'workers_comp', 'other')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),

  -- Filing rules
  timely_filing_days INTEGER,
  appeal_deadline_days INTEGER,

  -- Contact
  phone TEXT,
  website TEXT,
  portal_url TEXT,
  claims_address TEXT,

  -- Scoping
  company_id UUID REFERENCES companies(id),

  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_payers_type ON payers(type);
CREATE INDEX IF NOT EXISTS idx_payers_status ON payers(status);
CREATE INDEX IF NOT EXISTS idx_payers_company ON payers(company_id) WHERE company_id IS NOT NULL;

-- ============================================================
-- PAYER PRIOR AUTH RULES
-- ============================================================
CREATE TABLE IF NOT EXISTS payer_prior_auth_rules (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  payer_id TEXT NOT NULL REFERENCES payers(id),
  cpt_code TEXT NOT NULL,
  requires_prior_auth BOOLEAN NOT NULL DEFAULT true,
  auth_phone TEXT,
  auth_portal_url TEXT,
  notes TEXT,
  effective_date DATE,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_prior_auth_payer ON payer_prior_auth_rules(payer_id);
CREATE INDEX IF NOT EXISTS idx_prior_auth_cpt ON payer_prior_auth_rules(cpt_code);
CREATE INDEX IF NOT EXISTS idx_prior_auth_payer_cpt ON payer_prior_auth_rules(payer_id, cpt_code);

-- ============================================================
-- PAYER DENIAL CODE MAPPINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS payer_denial_mappings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  payer_id TEXT NOT NULL REFERENCES payers(id),
  denial_code TEXT NOT NULL,
  payer_description TEXT NOT NULL,
  standard_description TEXT,
  recommended_action TEXT,
  appeal_template_id UUID,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_denial_map_payer ON payer_denial_mappings(payer_id);
CREATE INDEX IF NOT EXISTS idx_denial_map_code ON payer_denial_mappings(denial_code);
CREATE INDEX IF NOT EXISTS idx_denial_map_payer_code ON payer_denial_mappings(payer_id, denial_code);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE payers ENABLE ROW LEVEL SECURITY;
ALTER TABLE payer_prior_auth_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE payer_denial_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON payers FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON payer_prior_auth_rules FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON payer_denial_mappings FOR ALL USING (true);
