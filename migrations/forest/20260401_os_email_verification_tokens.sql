-- Email verification tokens for OS Auth (ELLIE-1250)
-- Stores one-time tokens sent to users on registration to confirm their email.

CREATE TABLE os_email_verification_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES os_accounts(id) ON DELETE CASCADE,
  token       text UNIQUE NOT NULL,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_verification_token ON os_email_verification_tokens(token);
CREATE INDEX idx_email_verification_account ON os_email_verification_tokens(account_id);
