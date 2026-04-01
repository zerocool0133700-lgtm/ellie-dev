-- OS Sessions — token family model for refresh token rotation
-- Design doc: docs/architecture/os-identity-auth.md §3.1

BEGIN;

CREATE TABLE os_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES os_accounts(id) ON DELETE CASCADE,
  refresh_token   text UNIQUE NOT NULL,
  token_family    uuid NOT NULL,
  audience        text[] NOT NULL DEFAULT '{}',
  ip_address      inet,
  user_agent      text,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_os_sessions_account ON os_sessions(account_id);
CREATE INDEX idx_os_sessions_family ON os_sessions(token_family);
CREATE INDEX idx_os_sessions_refresh ON os_sessions(refresh_token);

COMMIT;
