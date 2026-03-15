-- Payer Integration Layer — ELLIE-755
-- EDI-837/835 + clearinghouse connectivity registry.

CREATE TABLE IF NOT EXISTS payer_integrations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  payer_id TEXT NOT NULL REFERENCES payers(id),
  payer_name TEXT NOT NULL,

  submission_method TEXT NOT NULL CHECK (submission_method IN ('edi', 'api', 'portal', 'sftp')),
  edi_payer_id TEXT,
  endpoint_url TEXT,
  sftp_host TEXT,
  sftp_credentials_ref TEXT,
  clearinghouse TEXT CHECK (clearinghouse IN ('availity', 'change_healthcare', 'trizetto', 'office_ally', 'other', NULL)),
  era_format TEXT DEFAULT '835' CHECK (era_format IN ('835', 'pdf', 'api')),

  company_id UUID NOT NULL REFERENCES companies(id),
  active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_pi_payer ON payer_integrations(payer_id);
CREATE INDEX IF NOT EXISTS idx_pi_company ON payer_integrations(company_id);
CREATE INDEX IF NOT EXISTS idx_pi_method ON payer_integrations(submission_method);
CREATE INDEX IF NOT EXISTS idx_pi_active ON payer_integrations(active) WHERE active = true;

ALTER TABLE payer_integrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON payer_integrations FOR ALL USING (true);
