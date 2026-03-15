-- Billing Operational Data Model — ELLIE-750
-- Full transactional schema for the medical billing pipeline.
-- All tables company_id scoped, soft deletes, JSONB metadata.

-- ============================================================
-- BILLING PATIENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS billing_patients (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  company_id UUID NOT NULL REFERENCES companies(id),
  mrn TEXT,
  fhir_patient_id TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  dob DATE,
  gender TEXT,
  member_id TEXT,
  phone TEXT,
  email TEXT,
  address JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_bp_company ON billing_patients(company_id);
CREATE INDEX IF NOT EXISTS idx_bp_mrn ON billing_patients(mrn) WHERE mrn IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bp_fhir ON billing_patients(fhir_patient_id) WHERE fhir_patient_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bp_name ON billing_patients(last_name, first_name);

-- ============================================================
-- COVERAGE (Insurance Plans)
-- ============================================================
CREATE TABLE IF NOT EXISTS billing_coverage (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  company_id UUID NOT NULL REFERENCES companies(id),
  patient_id UUID NOT NULL REFERENCES billing_patients(id),
  payer_id TEXT NOT NULL REFERENCES payers(id),
  plan_name TEXT,
  group_number TEXT,
  subscriber_id TEXT,
  member_id TEXT,
  effective_start DATE,
  effective_end DATE,
  copay_cents INTEGER,
  deductible_cents INTEGER,
  deductible_met_cents INTEGER DEFAULT 0,
  is_primary BOOLEAN DEFAULT true,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'terminated')),
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_bc_company ON billing_coverage(company_id);
CREATE INDEX IF NOT EXISTS idx_bc_patient ON billing_coverage(patient_id);
CREATE INDEX IF NOT EXISTS idx_bc_payer ON billing_coverage(payer_id);
CREATE INDEX IF NOT EXISTS idx_bc_status ON billing_coverage(status);

-- ============================================================
-- CLAIMS
-- ============================================================
CREATE TABLE IF NOT EXISTS billing_claims (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  company_id UUID NOT NULL REFERENCES companies(id),
  claim_number TEXT NOT NULL,
  patient_id UUID NOT NULL REFERENCES billing_patients(id),
  coverage_id UUID REFERENCES billing_coverage(id),
  payer_id TEXT NOT NULL REFERENCES payers(id),

  encounter_id TEXT,
  encounter_date DATE,
  provider_npi TEXT,
  facility_npi TEXT,
  place_of_service TEXT,

  primary_diagnosis TEXT NOT NULL,
  diagnosis_codes TEXT[] DEFAULT '{}',

  billed_cents INTEGER NOT NULL DEFAULT 0,
  allowed_cents INTEGER DEFAULT 0,
  paid_cents INTEGER DEFAULT 0,

  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'submitted', 'accepted', 'denied', 'partially_paid', 'paid', 'appealed', 'written_off', 'closed'
  )),

  submission_date DATE,
  timely_filing_deadline DATE,
  tracking_number TEXT,

  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_bcl_company ON billing_claims(company_id);
CREATE INDEX IF NOT EXISTS idx_bcl_patient ON billing_claims(patient_id);
CREATE INDEX IF NOT EXISTS idx_bcl_payer ON billing_claims(payer_id);
CREATE INDEX IF NOT EXISTS idx_bcl_status ON billing_claims(status);
CREATE INDEX IF NOT EXISTS idx_bcl_number ON billing_claims(claim_number);
CREATE INDEX IF NOT EXISTS idx_bcl_encounter ON billing_claims(encounter_id) WHERE encounter_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bcl_submission ON billing_claims(submission_date DESC) WHERE submission_date IS NOT NULL;

-- ============================================================
-- CLAIM LINE ITEMS
-- ============================================================
CREATE TABLE IF NOT EXISTS billing_claim_line_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  claim_id UUID NOT NULL REFERENCES billing_claims(id) ON DELETE CASCADE,
  line_number INTEGER NOT NULL,
  cpt_code TEXT NOT NULL,
  modifiers TEXT[] DEFAULT '{}',
  diagnosis_pointers INTEGER[] DEFAULT '{}',
  units INTEGER NOT NULL DEFAULT 1,
  charge_cents INTEGER NOT NULL DEFAULT 0,
  allowed_cents INTEGER DEFAULT 0,
  paid_cents INTEGER DEFAULT 0,
  denial_reason_code TEXT,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_bcli_claim ON billing_claim_line_items(claim_id);
CREATE INDEX IF NOT EXISTS idx_bcli_cpt ON billing_claim_line_items(cpt_code);

-- ============================================================
-- DENIALS
-- ============================================================
CREATE TABLE IF NOT EXISTS billing_denials (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  company_id UUID NOT NULL REFERENCES companies(id),
  claim_id UUID NOT NULL REFERENCES billing_claims(id),
  denial_code TEXT NOT NULL,
  denial_reason TEXT,
  category TEXT CHECK (category IN ('clinical', 'administrative', 'coverage', 'coding', 'timely_filing', 'authorization', 'other')),
  appeal_deadline DATE,
  resolution_status TEXT DEFAULT 'open' CHECK (resolution_status IN ('open', 'appealing', 'resolved', 'written_off')),
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_bd_company ON billing_denials(company_id);
CREATE INDEX IF NOT EXISTS idx_bd_claim ON billing_denials(claim_id);
CREATE INDEX IF NOT EXISTS idx_bd_code ON billing_denials(denial_code);
CREATE INDEX IF NOT EXISTS idx_bd_status ON billing_denials(resolution_status);

-- ============================================================
-- APPEALS
-- ============================================================
CREATE TABLE IF NOT EXISTS billing_appeals (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  company_id UUID NOT NULL REFERENCES companies(id),
  denial_id UUID NOT NULL REFERENCES billing_denials(id),
  appeal_level TEXT NOT NULL CHECK (appeal_level IN ('first', 'second', 'external_review')),
  letter_content TEXT,
  supporting_docs JSONB DEFAULT '[]',
  submission_date DATE,
  outcome TEXT CHECK (outcome IN ('pending', 'approved', 'denied', 'partial')),
  outcome_date DATE,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_ba_company ON billing_appeals(company_id);
CREATE INDEX IF NOT EXISTS idx_ba_denial ON billing_appeals(denial_id);
CREATE INDEX IF NOT EXISTS idx_ba_outcome ON billing_appeals(outcome);

-- ============================================================
-- PAYMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS billing_payments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  company_id UUID NOT NULL REFERENCES companies(id),
  claim_id UUID NOT NULL REFERENCES billing_claims(id),
  payer_id TEXT NOT NULL REFERENCES payers(id),
  check_or_eft_number TEXT,
  payment_date DATE NOT NULL,
  total_cents INTEGER NOT NULL DEFAULT 0,
  era_reference TEXT,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_bpay_company ON billing_payments(company_id);
CREATE INDEX IF NOT EXISTS idx_bpay_claim ON billing_payments(claim_id);
CREATE INDEX IF NOT EXISTS idx_bpay_payer ON billing_payments(payer_id);
CREATE INDEX IF NOT EXISTS idx_bpay_date ON billing_payments(payment_date DESC);

-- ============================================================
-- PAYMENT ALLOCATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS billing_payment_allocations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  payment_id UUID NOT NULL REFERENCES billing_payments(id) ON DELETE CASCADE,
  claim_line_item_id UUID NOT NULL REFERENCES billing_claim_line_items(id),
  paid_cents INTEGER NOT NULL DEFAULT 0,
  contractual_adjustment_cents INTEGER DEFAULT 0,
  patient_responsibility_cents INTEGER DEFAULT 0,
  adjustment_reason_code TEXT,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_bpa_payment ON billing_payment_allocations(payment_id);
CREATE INDEX IF NOT EXISTS idx_bpa_line ON billing_payment_allocations(claim_line_item_id);

-- ============================================================
-- WORK QUEUE
-- ============================================================
CREATE TABLE IF NOT EXISTS billing_work_queue (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  company_id UUID NOT NULL REFERENCES companies(id),
  claim_id UUID REFERENCES billing_claims(id),
  task_type TEXT NOT NULL CHECK (task_type IN ('submit', 'follow_up', 'appeal', 'post_payment', 'review', 'write_off')),
  assigned_agent TEXT,
  priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  due_date DATE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
  notes TEXT,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_bwq_company ON billing_work_queue(company_id);
CREATE INDEX IF NOT EXISTS idx_bwq_status ON billing_work_queue(status);
CREATE INDEX IF NOT EXISTS idx_bwq_agent ON billing_work_queue(assigned_agent) WHERE assigned_agent IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bwq_priority ON billing_work_queue(priority, due_date ASC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_bwq_claim ON billing_work_queue(claim_id) WHERE claim_id IS NOT NULL;

-- ============================================================
-- BILLING AUDIT LOG
-- ============================================================
CREATE TABLE IF NOT EXISTS billing_audit_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  company_id UUID NOT NULL REFERENCES companies(id),
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_type TEXT DEFAULT 'agent' CHECK (actor_type IN ('agent', 'human', 'system')),
  before_state JSONB,
  after_state JSONB,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_bal_company ON billing_audit_log(company_id);
CREATE INDEX IF NOT EXISTS idx_bal_entity ON billing_audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_bal_created ON billing_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bal_actor ON billing_audit_log(actor);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE billing_patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_claim_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_denials ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_appeals ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_work_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON billing_patients FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON billing_coverage FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON billing_claims FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON billing_claim_line_items FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON billing_denials FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON billing_appeals FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON billing_payments FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON billing_payment_allocations FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON billing_work_queue FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON billing_audit_log FOR ALL USING (true);
