# Ellie OS — Identity & Authorization Architecture

> Strategic design document — ready for ticketing.
> Core principle: **Shared Identity, Scoped Authorization.**
> OS owns identity/authentication. Products own authorization/permissions.

**Status:** Draft — pending team review
**Date:** 2026-04-01
**Stakeholders:** Dave (product), Kate (strategy), Brian (critique/hardening), Dev agent (implementation)

---

## 1. Current State

The system today has no unified consumer identity layer. What exists:

| Component | Location | Purpose |
|-----------|----------|---------|
| `jwt-auth.ts` | ellie-dev | Short-lived audience-scoped JWTs for public API (TTS/STT) |
| `permission-auth.ts` | ellie-dev | Entity-based guards (`x-entity-id`, `x-bridge-key`) |
| `vault.ts` | ellie-dev | AES-256-GCM encrypted credential storage |
| RBAC schema | Forest DB | `rbac_entities`, `rbac_roles`, `rbac_permissions` — agent/user authorization |
| Company scoping | Supabase | `companies` table + RLS via `app.current_company_id` |
| `identity-startup.ts` | ellie-dev | Agent identity bindings (archetype + role) — NOT consumer auth |
| People/Groups | Supabase | Social graph — relationship tracking, not authentication |

**Gaps:**
- No consumer sign-up, login, password reset, or email verification
- No `os_accounts` table — identity is scattered across RBAC entities, people, and agent tables
- No session management for browser-based products
- No cross-product SSO
- No minor/child account handling (blocker for Learn)
- No org/classroom isolation
- RBAC is internal (agent permissions), not consumer-facing

---

## 2. Target Architecture

### 2.1 Layered Responsibility Model

```
┌─────────────────────────────────────────────────┐
│                   OS LAYER                       │
│  Identity · Authentication · Sessions · Audit    │
├─────────────────────────────────────────────────┤
│          os_accounts (single source)             │
│          os_sessions (JWT + refresh)             │
│          os_auth_methods (email, OAuth, magic)   │
│          os_product_memberships (linking layer)  │
│          os_cross_product_consents               │
│          os_audit_log                            │
├────────────────────┬────────────────────────────┤
│   ELLIE LIFE       │      ELLIE LEARN           │
│  (consumer app)    │   (education platform)      │
│                    │                              │
│  life_roles        │  learn_roles                │
│  life_entitlements │  learn_orgs                 │
│  life_preferences  │  learn_classrooms           │
│  life_rls_policies │  learn_memberships          │
│                    │  learn_guardian_links        │
│                    │  learn_consent_records       │
│                    │  learn_rls_policies          │
└────────────────────┴────────────────────────────┘
```

### 2.2 OS Layer — What It Owns

**Identity** — one account per human, globally unique email.

**Authentication** — all methods live at OS layer:
- Email + password (argon2id hashing)
- Magic link (passwordless email)
- OAuth 2.0 (Google, Apple, Microsoft)
- Future: passkeys/WebAuthn

**Sessions** — unified JWT architecture:
- Access token: short-lived (15 min), audience-scoped per product
- Refresh token: long-lived (30 days), stored server-side, rotated on use
- Token payload carries `product_memberships[]` with roles and entitlements per product
- SSO: authenticating to any Ellie product authenticates to all (shared refresh token family)

**Audit** — structured event log for all auth events:
- Login, logout, token refresh, password change, permission grant/revoke
- Immutable append-only table with retention policy

### 2.3 Product Layer — What It Owns

Each product defines its own:
- **Role taxonomy** — Life might have `free`, `pro`, `family_admin`; Learn might have `student`, `teacher`, `org_admin`, `guardian`
- **Entitlements** — what features/tiers are unlocked (stored as JSONB on product membership)
- **Data access policies** — product-specific RLS using `app.current_account_id` + role from JWT
- **Feature flags** — per-product, tied to entitlements
- **Consent/privacy** — product-specific consent flows (especially Learn for COPPA/FERPA)

### 2.4 The Linking Layer: `os_product_memberships`

This is the bridge between OS identity and product authorization:

```sql
os_product_memberships (
  id            uuid PRIMARY KEY,
  account_id    uuid REFERENCES os_accounts(id),
  product       text NOT NULL,           -- 'life', 'learn'
  roles         text[] NOT NULL DEFAULT '{}',
  entitlements  jsonb NOT NULL DEFAULT '{}',
  org_id        uuid,                    -- NULL for Life, required for Learn
  status        text NOT NULL DEFAULT 'active',
  created_at    timestamptz,
  updated_at    timestamptz,
  UNIQUE(account_id, product, org_id)
);
```

The JWT carries a snapshot of this at token issuance. Products read roles/entitlements from the token — no round-trip to OS on every request.

---

## 3. Schema Design

### 3.1 OS Layer Tables (Forest DB or dedicated OS Postgres)

```sql
-- Core identity
CREATE TABLE os_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text UNIQUE NOT NULL,
  email_verified  boolean NOT NULL DEFAULT false,
  entity_type     text NOT NULL DEFAULT 'user',
    -- 'user', 'minor', 'org_service_account'
  display_name    text,
  password_hash   text,              -- NULL if OAuth/magic-link only
  mfa_enabled     boolean NOT NULL DEFAULT false,
  mfa_secret      text,              -- encrypted, NULL if not enrolled
  status          text NOT NULL DEFAULT 'active',
    -- 'active', 'suspended', 'pending_verification', 'deleted'
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz         -- soft delete
);

-- Authentication methods (supports multiple per account)
CREATE TABLE os_auth_methods (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES os_accounts(id),
  method          text NOT NULL,
    -- 'email_password', 'magic_link', 'oauth_google', 'oauth_apple', 'oauth_microsoft'
  provider_uid    text,              -- OAuth subject ID
  metadata        jsonb DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, method)
);

-- Session management
CREATE TABLE os_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES os_accounts(id),
  refresh_token   text UNIQUE NOT NULL,
  token_family    uuid NOT NULL,      -- for refresh token rotation detection
  audience        text[] NOT NULL,    -- ['life', 'learn'] — which products this session covers
  ip_address      inet,
  user_agent      text,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Product memberships (the bridge)
CREATE TABLE os_product_memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES os_accounts(id),
  product         text NOT NULL,
  roles           text[] NOT NULL DEFAULT '{}',
  entitlements    jsonb NOT NULL DEFAULT '{}',
  org_id          uuid,               -- NULL for non-org products
  status          text NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, product, org_id)
);

-- Cross-product data sharing consent
CREATE TABLE os_cross_product_consents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES os_accounts(id),
  source_product  text NOT NULL,
  target_product  text NOT NULL,
  consent_type    text NOT NULL,      -- 'progress_sharing', 'profile_sync', etc.
  granted         boolean NOT NULL DEFAULT false,
  granted_at      timestamptz,
  revoked_at      timestamptz,
  UNIQUE(account_id, source_product, target_product, consent_type)
);

-- Immutable audit log
CREATE TABLE os_audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid,               -- NULL for anonymous events (failed login attempts)
  event_type      text NOT NULL,
    -- 'login', 'logout', 'token_refresh', 'password_change', 'mfa_enroll',
    -- 'permission_grant', 'permission_revoke', 'account_create', 'account_delete'
  product         text,               -- which product context, if any
  ip_address      inet,
  user_agent      text,
  metadata        jsonb DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_account ON os_audit_log(account_id, created_at DESC);
CREATE INDEX idx_audit_event ON os_audit_log(event_type, created_at DESC);
```

### 3.2 Learn Product Tables (product-owned)

```sql
-- Organizational isolation
CREATE TABLE learn_orgs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  slug            text UNIQUE NOT NULL,
  org_type        text NOT NULL,      -- 'school', 'district', 'homeschool_coop', 'tutoring'
  settings        jsonb DEFAULT '{}',
  coppa_required  boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Classrooms within orgs
CREATE TABLE learn_classrooms (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES learn_orgs(id),
  name            text NOT NULL,
  grade_level     text,
  created_by      uuid NOT NULL,       -- os_accounts.id of teacher
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Classroom membership (references OS identity)
CREATE TABLE learn_memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  classroom_id    uuid NOT NULL REFERENCES learn_classrooms(id),
  account_id      uuid NOT NULL,       -- os_accounts.id
  role            text NOT NULL,        -- 'student', 'teacher', 'aide'
  joined_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE(classroom_id, account_id)
);

-- Guardian-minor links (COPPA compliance)
CREATE TABLE learn_guardian_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guardian_id     uuid NOT NULL,        -- os_accounts.id (entity_type = 'user')
  minor_id        uuid NOT NULL,        -- os_accounts.id (entity_type = 'minor')
  relationship    text NOT NULL,        -- 'parent', 'legal_guardian'
  verified        boolean NOT NULL DEFAULT false,
  verified_at     timestamptz,
  consent_given   boolean NOT NULL DEFAULT false,
  consent_given_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(guardian_id, minor_id)
);

-- COPPA/FERPA consent records (immutable)
CREATE TABLE learn_consent_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  minor_id        uuid NOT NULL,        -- os_accounts.id
  guardian_id     uuid NOT NULL,        -- os_accounts.id
  org_id          uuid REFERENCES learn_orgs(id),
  consent_type    text NOT NULL,
    -- 'coppa_collection', 'ferpa_directory', 'data_sharing', 'ai_interaction'
  granted         boolean NOT NULL,
  method          text NOT NULL,        -- 'email_verification', 'signed_form', 'in_app'
  evidence_ref    text,                 -- link to signed document or verification record
  ip_address      inet,
  created_at      timestamptz NOT NULL DEFAULT now()
  -- No update/delete — consent changes are new rows
);
```

---

## 4. JWT Architecture

### 4.1 Access Token Payload

```json
{
  "sub": "account-uuid",
  "aud": "life",
  "iss": "ellie-os",
  "iat": 1711929600,
  "exp": 1711930500,
  "email": "dave@example.com",
  "entity_type": "user",
  "memberships": {
    "life": {
      "roles": ["pro"],
      "entitlements": { "tier": "pro", "add_ons": ["voice"] }
    },
    "learn": {
      "roles": ["teacher", "org_admin"],
      "entitlements": {},
      "org_id": "org-uuid"
    }
  }
}
```

### 4.2 Token Lifecycle

1. **Login** → OS issues access token (15 min) + refresh token (30 days) + sets `token_family`
2. **API request** → product validates access token locally (signature + expiry + audience)
3. **Token refresh** → OS validates refresh token, issues new pair, rotates refresh token
4. **Rotation detection** → if a used refresh token is replayed, revoke the entire `token_family` (compromise mitigation)
5. **Logout** → revoke all sessions in the token family
6. **Cross-product SSO** → refresh token covers all products in `audience[]`; accessing a new product extends the audience

### 4.3 Signing

- RS256 (asymmetric) — OS holds private key, products hold public key
- Products can verify tokens without calling OS
- Key rotation via JWKS endpoint (`/.well-known/jwks.json`)

---

## 5. Addressing Brian's Critique

Brian's review identified critical gaps in the initial architecture sketch. Here's how each is addressed:

### 5.1 Minor Account Lifecycle

**Gap:** Original sketch had no `entity_type` or handling for accounts that can't self-consent.

**Resolution:**
- `os_accounts.entity_type` distinguishes `user` vs `minor` vs `org_service_account`
- Minors cannot: reset their own password, delete their account, grant cross-product consent, or modify guardian links
- Guardian link must be verified before a minor account is activated
- `learn_guardian_links.verified` + `consent_given` are separate booleans — a guardian can be verified but not yet have granted consent
- Consent is immutable audit trail (`learn_consent_records`) — revocation is a new row with `granted: false`

### 5.2 COPPA/FERPA Compliance

**Gap:** Original sketch mentioned COPPA/FERPA as requirements but had no concrete mechanism.

**Resolution:**
- **COPPA:** Before collecting data from a minor (under 13), verifiable parental consent required. `learn_consent_records` with `consent_type: 'coppa_collection'` and `method` documenting how consent was obtained (email verification, signed form, etc.)
- **FERPA:** Educational records accessible only to parents and authorized school officials. Enforced via:
  - Org-scoped RLS: student data visible only within their org
  - `learn_consent_records` with `consent_type: 'ferpa_directory'` for directory information sharing
  - Teacher/aide access scoped to their classrooms via `learn_memberships`
- **Data minimization:** Minor accounts store minimal PII at OS level (no email for youngest students — org assigns an opaque identifier); full profile data lives in Learn product layer behind org RLS
- **Deletion/export:** OS provides account deletion + data export endpoints; product layers implement their own data purge cascades

### 5.3 Org Isolation

**Gap:** Company scoping exists for internal multi-tenancy but doesn't address educational org boundaries.

**Resolution:**
- `learn_orgs` is completely separate from `companies` (different domain, different rules)
- Every Learn query filters by `org_id` via RLS — a teacher at Org A cannot see students at Org B
- `os_product_memberships.org_id` ties the OS identity to a specific org context
- A single account can belong to multiple orgs (e.g., a teacher at two schools) — each gets a separate membership row
- Org admins manage their own users but cannot see other orgs

### 5.4 Token Bloat

**Gap:** Putting all memberships in every JWT could create oversized tokens.

**Resolution:**
- Access tokens are audience-scoped — a token for `aud: "life"` only carries Life memberships
- Cross-product tokens (for SSO flows) carry a summary: roles + org_id, not full entitlements
- Entitlements JSONB is kept shallow (tier + add_on list, not deeply nested)
- If a user has 10+ org memberships, the token carries only the active org context; a separate `/switch-org` endpoint issues a new token for a different org
- Hard limit: if token exceeds 4KB, fall back to opaque token + introspection endpoint

### 5.5 Account Merge / Conflict

**Gap:** What happens when a user signs up with email on Life, then OAuth on Learn, and they're the same person?

**Resolution:**
- Email is the identity anchor — if the email matches, it's the same account
- OAuth login with a known email auto-links to existing account (after email verification)
- `os_auth_methods` supports multiple methods per account — no need to merge
- If emails differ (e.g., personal vs school), accounts remain separate; a future "link accounts" flow can merge them with user consent
- Merge is a privileged operation: requires verification of both accounts, creates an audit log entry, and reassigns all product memberships to the surviving account

### 5.6 Rate Limiting & Abuse

**Gap:** No mention of brute-force protection.

**Resolution:**
- Login attempts rate-limited per IP (10/min) and per account (5/min)
- Magic link requests rate-limited per email (3/hour)
- Failed login attempts logged to `os_audit_log` with IP
- Account lockout after 10 consecutive failures (unlock via email or admin)
- Refresh token rotation detects replay attacks — revokes entire family on reuse

### 5.7 Migration Path from Current State

**Gap:** How do we get from the current scattered state to unified identity?

**Resolution:** See Section 7 (Migration Strategy) below.

---

## 6. Integration with Existing Systems

### 6.1 RBAC Coexistence

The existing `rbac_entities` / `rbac_roles` / `rbac_permissions` system (ELLIE-789) handles **internal agent authorization**. It does NOT get replaced.

- `os_accounts` is for consumer identity
- `rbac_entities` is for system entities (agents, super_agents, Dave as super_user)
- Dave's `os_accounts` row links to his `rbac_entities` row via a `system_entity_id` column (optional, only for admin users)
- Long-term: RBAC can reference `os_accounts.id` instead of maintaining its own entity table, but this is a separate migration with no urgency

### 6.2 Existing JWT Auth

`src/api/jwt-auth.ts` currently issues audience-scoped JWTs for API endpoints. This becomes a **product-level concern** — it stays where it is, but the signing key and validation logic align with the OS JWKS standard.

Migration: update `jwt-auth.ts` to validate against the OS JWKS endpoint instead of a local secret. Existing API tokens continue working during a transition period.

### 6.3 Company Scoping

`companies` table + RLS remains for internal B2B multi-tenancy (Ellie Labs, future clients). It is orthogonal to `learn_orgs`:

- `companies` = who operates the Ellie instance
- `learn_orgs` = educational organizations within a company's instance

A Learn deployment for "Springfield School District" would be one `company` with many `learn_orgs` (individual schools).

### 6.4 People/Groups

The existing `people` and `groups` tables are a social graph — they track relationships Ellie knows about. They do NOT become identity tables.

If a `person` in the social graph creates an Ellie account, `people.account_id` (new FK) links to `os_accounts.id`. This is optional — not all people Ellie knows about will have accounts.

---

## 7. Migration Strategy

### Phase 0: Foundation (no user-facing changes)
1. Create `os_accounts`, `os_auth_methods`, `os_sessions` tables
2. Create `os_product_memberships`, `os_cross_product_consents`, `os_audit_log` tables
3. Build OS auth service: registration, login, token issuance, refresh, JWKS endpoint
4. Write comprehensive tests for token lifecycle and rotation detection

### Phase 1: Life Integration
5. Create Dave's `os_accounts` row + migrate existing Life user data
6. Update Life app to authenticate via OS (login page, token validation)
7. Implement Life-specific roles and entitlements in `os_product_memberships`
8. Update Life RLS to use `app.current_account_id` from OS JWT
9. Deprecate legacy auth paths with transition period

### Phase 2: Learn Foundation
10. Create `learn_orgs`, `learn_classrooms`, `learn_memberships` tables
11. Build guardian-minor link flow with verification
12. Build COPPA consent collection flow (email verification method first)
13. Implement Learn RLS policies (org-scoped, classroom-scoped)
14. Build org admin dashboard (user management within their org)

### Phase 3: Cross-Product
15. Implement SSO — authenticating to Life also authenticates to Learn (and vice versa)
16. Build cross-product consent UI (`os_cross_product_consents`)
17. Implement `/switch-org` endpoint for multi-org users
18. Add account linking flow for users with separate Life/Learn accounts

### Phase 4: Hardening
19. Rate limiting (per-IP, per-account)
20. Account lockout + unlock flow
21. MFA enrollment + verification (TOTP first, then WebAuthn)
22. Data export + account deletion endpoints (GDPR/COPPA "right to delete")
23. Audit log retention policy + admin query UI
24. Penetration testing of auth flows

---

## 8. Ticket Breakdown

Each ticket is scoped for one agent work session (~2-4 hours).

### Phase 0 — Foundation

| Ticket | Title | Dependencies | Estimate |
|--------|-------|-------------|----------|
| **ELLIE-TBD-01** | Create OS identity schema (`os_accounts`, `os_auth_methods`) | None | S |
| **ELLIE-TBD-02** | Create OS session schema (`os_sessions`) + token family model | 01 | S |
| **ELLIE-TBD-03** | Create OS product memberships + consents + audit log schema | 01 | S |
| **ELLIE-TBD-04** | Build OS auth service: registration + email verification | 01 | M |
| **ELLIE-TBD-05** | Build OS auth service: login (email/password + magic link) | 01, 04 | M |
| **ELLIE-TBD-06** | Build OS auth service: JWT issuance + JWKS endpoint | 02, 05 | M |
| **ELLIE-TBD-07** | Build OS auth service: token refresh + rotation detection | 06 | M |
| **ELLIE-TBD-08** | OAuth 2.0 provider integration (Google first) | 05, 06 | M |
| **ELLIE-TBD-09** | Auth service test suite (token lifecycle, rotation, edge cases) | 04-07 | M |

### Phase 1 — Life Integration

| Ticket | Title | Dependencies | Estimate |
|--------|-------|-------------|----------|
| **ELLIE-TBD-10** | Migrate existing Life user data to `os_accounts` | 01 | S |
| **ELLIE-TBD-11** | Life login page + OS auth integration | 06, 10 | M |
| **ELLIE-TBD-12** | Life roles/entitlements in `os_product_memberships` | 03, 10 | S |
| **ELLIE-TBD-13** | Update Life RLS to use OS JWT `account_id` | 06, 12 | M |
| **ELLIE-TBD-14** | Deprecate legacy Life auth + transition period | 11, 13 | S |

### Phase 2 — Learn Foundation

| Ticket | Title | Dependencies | Estimate |
|--------|-------|-------------|----------|
| **ELLIE-TBD-15** | Create Learn schema (`learn_orgs`, `learn_classrooms`, `learn_memberships`) | 01 | S |
| **ELLIE-TBD-16** | Guardian-minor link flow + verification | 01, 15 | M |
| **ELLIE-TBD-17** | COPPA consent collection (email verification method) | 16 | M |
| **ELLIE-TBD-18** | Learn RLS policies (org-scoped + classroom-scoped) | 15 | M |
| **ELLIE-TBD-19** | Org admin dashboard: user management within org | 15, 16 | L |
| **ELLIE-TBD-20** | FERPA compliance: directory info consent + audit trail | 17, 18 | M |

### Phase 3 — Cross-Product

| Ticket | Title | Dependencies | Estimate |
|--------|-------|-------------|----------|
| **ELLIE-TBD-21** | SSO: shared refresh token family across products | 07 | M |
| **ELLIE-TBD-22** | Cross-product consent UI + `os_cross_product_consents` flows | 03, 11 | M |
| **ELLIE-TBD-23** | `/switch-org` endpoint for multi-org users | 06, 15 | S |
| **ELLIE-TBD-24** | Account linking flow (merge Life + Learn accounts) | 21 | M |

### Phase 4 — Hardening

| Ticket | Title | Dependencies | Estimate |
|--------|-------|-------------|----------|
| **ELLIE-TBD-25** | Rate limiting: login, magic link, token refresh | 05-07 | S |
| **ELLIE-TBD-26** | Account lockout + admin unlock flow | 25 | S |
| **ELLIE-TBD-27** | MFA enrollment + TOTP verification | 05 | M |
| **ELLIE-TBD-28** | Data export + account deletion (GDPR/COPPA right-to-delete) | 01, 15 | M |
| **ELLIE-TBD-29** | Audit log retention policy + admin query endpoint | 03 | S |
| **ELLIE-TBD-30** | Security review: penetration testing of auth flows | All | L |

**Size key:** S = ~2h, M = ~4h, L = ~6h+

---

## 9. Open Questions

1. **Where does the OS auth service live?** ~~Options: (a) new `ellie-os-auth` service, (b) endpoints in `ellie-dev` relay, (c) Supabase Auth with custom claims. Recommendation: **(a)** — dedicated service, clean separation.~~ **Decision: (b)** — `src/os-auth/` module within ellie-dev relay. Simpler deployment; relay is the de facto OS layer. Can extract to a dedicated service later if needed.

2. **Database home for OS tables:** Options: (a) Forest DB (local Postgres), (b) Supabase (cloud), (c) dedicated OS Postgres. Recommendation: **(c)** for production, **(a)** for dev — OS identity should not depend on either product's database.

3. **Minor account creation flow:** Does the org admin create minor accounts (school-managed), or does the guardian create them (parent-managed)? Likely both — need to support org-provisioned accounts AND parent self-service.

4. **Email for youngest minors:** Children under ~10 may not have email. Options: org-assigned opaque ID, guardian email with suffix, or username-only. Recommendation: org-assigned identifier with guardian email as recovery.

5. **Existing `rbac_entities` convergence timeline:** When (if ever) do we unify internal RBAC entities with `os_accounts`? No urgency — keep them separate for now, revisit after Learn launch.

---

## 10. Success Criteria

- [ ] A user can create one account and access both Life and Learn without re-registering
- [ ] A teacher can manage students in their classroom without seeing other orgs' data
- [ ] A parent can grant/revoke COPPA consent for their child's Learn account
- [ ] Token refresh works seamlessly across products (no re-login)
- [ ] Compromised refresh token triggers family-wide revocation
- [ ] Audit log captures all auth events with enough detail for incident response
- [ ] Zero hardcoded secrets — all signing keys in vault or env, rotatable via JWKS
- [ ] Learn can launch with full COPPA/FERPA compliance from day one
