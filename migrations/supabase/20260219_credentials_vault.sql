-- ELLIE-32: Secure credential vault for authenticated site access
-- Run against Supabase SQL editor

CREATE TABLE IF NOT EXISTS credentials (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  label TEXT NOT NULL,
  domain TEXT NOT NULL,
  credential_type TEXT NOT NULL CHECK (credential_type IN (
    'password', 'api_key', 'bearer_token', 'cookie', 'oauth'
  )),
  encrypted_data TEXT NOT NULL,
  notes TEXT,
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credentials_domain ON credentials(domain);
CREATE INDEX IF NOT EXISTS idx_credentials_type ON credentials(credential_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_credentials_label ON credentials(label);

-- Enable RLS
ALTER TABLE credentials ENABLE ROW LEVEL SECURITY;

-- Allow all operations (single-user system)
CREATE POLICY "Allow all" ON credentials FOR ALL USING (true) WITH CHECK (true);
