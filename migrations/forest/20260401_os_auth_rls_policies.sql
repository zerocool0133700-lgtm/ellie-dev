-- RLS policies for OS auth tables (ELLIE-1257)
--
-- All OS auth tables are accessed exclusively via the service role
-- (the relay's Postgres connection). RLS is enabled as defence-in-depth:
-- if any path ever exposes these tables to a non-service role, the
-- default-deny policy blocks access.
--
-- The service role (used by the relay) bypasses RLS automatically
-- because it is a superuser / the table owner. These policies only
-- affect non-owner roles.

BEGIN;

-- ── os_accounts ────────────────────────────────────────────
ALTER TABLE os_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE os_accounts FORCE ROW LEVEL SECURITY;

-- Service role (table owner) bypasses RLS.
-- No policies = default-deny for all other roles.

-- ── os_auth_methods ────────────────────────────────────────
ALTER TABLE os_auth_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE os_auth_methods FORCE ROW LEVEL SECURITY;

-- ── os_sessions ────────────────────────────────────────────
ALTER TABLE os_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE os_sessions FORCE ROW LEVEL SECURITY;

-- ── os_email_verification_tokens ───────────────────────────
ALTER TABLE os_email_verification_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE os_email_verification_tokens FORCE ROW LEVEL SECURITY;

-- ── os_product_memberships ─────────────────────────────────
ALTER TABLE os_product_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE os_product_memberships FORCE ROW LEVEL SECURITY;

-- ── os_cross_product_consents ──────────────────────────────
ALTER TABLE os_cross_product_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE os_cross_product_consents FORCE ROW LEVEL SECURITY;

-- ── os_audit_log ───────────────────────────────────────────
ALTER TABLE os_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE os_audit_log FORCE ROW LEVEL SECURITY;

-- ── os_rate_limits ─────────────────────────────────────────
ALTER TABLE os_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE os_rate_limits FORCE ROW LEVEL SECURITY;

COMMIT;
