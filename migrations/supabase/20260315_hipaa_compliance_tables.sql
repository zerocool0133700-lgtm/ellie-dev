-- HIPAA Compliance Framework — ELLIE-753
-- State-specific billing rules, BAA tracking, immutable billing audit.

-- ============================================================
-- STATE BILLING RULES
-- ============================================================
CREATE TABLE IF NOT EXISTS state_billing_rules (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  state_code TEXT NOT NULL,
  rule_type TEXT NOT NULL CHECK (rule_type IN (
    'timely_filing', 'prior_authorization', 'billing_format',
    'patient_balance_limit', 'appeal_deadline', 'other'
  )),
  payer_type TEXT CHECK (payer_type IN ('commercial', 'medicare', 'medicaid', 'workers_comp', 'all')),
  description TEXT NOT NULL,
  value_days INTEGER,
  value_cents INTEGER,
  value_text TEXT,
  effective_date DATE,
  expiration_date DATE,
  source_reference TEXT,
  company_id UUID REFERENCES companies(id),
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_sbr_state ON state_billing_rules(state_code);
CREATE INDEX IF NOT EXISTS idx_sbr_type ON state_billing_rules(rule_type);
CREATE INDEX IF NOT EXISTS idx_sbr_state_type ON state_billing_rules(state_code, rule_type);
CREATE INDEX IF NOT EXISTS idx_sbr_company ON state_billing_rules(company_id) WHERE company_id IS NOT NULL;

-- ============================================================
-- BUSINESS ASSOCIATE AGREEMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS business_associate_agreements (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  company_id UUID NOT NULL REFERENCES companies(id),
  vendor_name TEXT NOT NULL,
  service_description TEXT NOT NULL,
  stores_phi BOOLEAN NOT NULL DEFAULT false,
  processes_phi BOOLEAN NOT NULL DEFAULT false,
  baa_status TEXT NOT NULL DEFAULT 'not_started' CHECK (baa_status IN (
    'not_started', 'in_progress', 'signed', 'expired', 'not_applicable'
  )),
  signed_date DATE,
  expiration_date DATE,
  document_url TEXT,
  contact_email TEXT,
  notes TEXT,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_baa_company ON business_associate_agreements(company_id);
CREATE INDEX IF NOT EXISTS idx_baa_status ON business_associate_agreements(baa_status);
CREATE INDEX IF NOT EXISTS idx_baa_vendor ON business_associate_agreements(vendor_name);

-- ============================================================
-- IMMUTABLE BILLING AUDIT (append-only constraint)
-- ============================================================
-- Prevent UPDATE and DELETE on billing_audit_log via trigger.
CREATE OR REPLACE FUNCTION prevent_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'billing_audit_log is immutable: % not allowed', TG_OP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_immutable_audit_update ON billing_audit_log;
CREATE TRIGGER trg_immutable_audit_update
  BEFORE UPDATE ON billing_audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_modification();

DROP TRIGGER IF EXISTS trg_immutable_audit_delete ON billing_audit_log;
CREATE TRIGGER trg_immutable_audit_delete
  BEFORE DELETE ON billing_audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_modification();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE state_billing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_associate_agreements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON state_billing_rules FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON business_associate_agreements FOR ALL USING (true);
