-- OS Product Memberships, Cross-Product Consents, Audit Log
-- Design doc: docs/architecture/os-identity-auth.md §3.1

BEGIN;

CREATE TABLE os_product_memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES os_accounts(id) ON DELETE CASCADE,
  product         text NOT NULL,
  roles           text[] NOT NULL DEFAULT '{}',
  entitlements    jsonb NOT NULL DEFAULT '{}',
  org_id          uuid,
  status          text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'revoked')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_os_memberships_account ON os_product_memberships(account_id);
CREATE INDEX idx_os_memberships_product ON os_product_memberships(product, status);
CREATE UNIQUE INDEX idx_os_memberships_unique ON os_product_memberships(account_id, product, COALESCE(org_id, '00000000-0000-0000-0000-000000000000'));

CREATE TABLE os_cross_product_consents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES os_accounts(id) ON DELETE CASCADE,
  source_product  text NOT NULL,
  target_product  text NOT NULL,
  consent_type    text NOT NULL,
  granted         boolean NOT NULL DEFAULT false,
  granted_at      timestamptz,
  revoked_at      timestamptz,
  UNIQUE(account_id, source_product, target_product, consent_type)
);

CREATE TABLE os_audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid,
  event_type      text NOT NULL,
  product         text,
  ip_address      inet,
  user_agent      text,
  metadata        jsonb DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_os_audit_account ON os_audit_log(account_id, created_at DESC);
CREATE INDEX idx_os_audit_event ON os_audit_log(event_type, created_at DESC);

COMMIT;
