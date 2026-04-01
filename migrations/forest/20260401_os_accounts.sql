-- OS Identity & Auth Methods — Phase 0 Foundation
-- Design doc: docs/architecture/os-identity-auth.md

BEGIN;

CREATE TABLE os_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text UNIQUE NOT NULL,
  email_verified  boolean NOT NULL DEFAULT false,
  entity_type     text NOT NULL DEFAULT 'user'
    CHECK (entity_type IN ('user', 'minor', 'org_service_account')),
  display_name    text,
  password_hash   text,
  mfa_enabled     boolean NOT NULL DEFAULT false,
  mfa_secret      text,
  status          text NOT NULL DEFAULT 'pending_verification'
    CHECK (status IN ('active', 'suspended', 'pending_verification', 'deleted')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE INDEX idx_os_accounts_email ON os_accounts(email);
CREATE INDEX idx_os_accounts_status ON os_accounts(status);

CREATE TABLE os_auth_methods (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES os_accounts(id) ON DELETE CASCADE,
  method          text NOT NULL
    CHECK (method IN ('email_password', 'magic_link', 'oauth_google', 'oauth_apple', 'oauth_microsoft')),
  provider_uid    text,
  metadata        jsonb DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, method)
);

CREATE INDEX idx_os_auth_methods_account ON os_auth_methods(account_id);

COMMIT;
