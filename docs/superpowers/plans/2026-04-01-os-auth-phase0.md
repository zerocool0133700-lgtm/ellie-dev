# OS Auth Phase 0 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the core OS identity and authentication service as `src/os-auth/` within ellie-dev, implementing unified account management, password hashing, JWT issuance (RS256), token refresh with rotation detection, and audit logging.

**Architecture:** OS auth lives in ellie-dev as a self-contained module (`src/os-auth/`). Tables live in Forest DB. Routes are wired into the existing http-routes.ts handler via a single `handleOsAuthRoute()` dispatcher. RS256 signing keys are stored in The Hollow (encrypted vault). The module follows existing project patterns: postgres.js for DB, `jsonwebtoken` for JWTs, `ApiRequest`/`ApiResponse` types for handlers.

**Tech Stack:** postgres.js (Forest DB), jsonwebtoken (RS256), argon2 (password hashing), node:crypto (key generation, random tokens), The Hollow (key storage)

**Decision:** Option B chosen — OS auth stays in ellie-dev relay, NOT a separate service. Relay becomes the de facto OS layer. Simpler deployment, single process.

---

## File Structure

```
src/os-auth/
├── index.ts              — Route dispatcher (handleOsAuthRoute)
├── schema.ts             — Type definitions for all OS auth tables
├── passwords.ts          — argon2id hash + verify (thin wrapper)
├── keys.ts               — RS256 key pair generation, storage in Hollow, JWKS formatting
├── tokens.ts             — Access token (sign/verify), refresh token (create/rotate/revoke)
├── registration.ts       — Account creation + email verification
├── login.ts              — Email/password login + magic link
├── sessions.ts           — Session CRUD, token family management
├── memberships.ts        — Product membership read/write
├── audit.ts              — Append-only audit log writer
├── middleware.ts         — authenticateOsRequest() helper for downstream routes

migrations/forest/
├── 20260401_os_accounts.sql           — os_accounts + os_auth_methods
├── 20260401_os_sessions.sql           — os_sessions (token families)
├── 20260401_os_product_memberships.sql — memberships + consents + audit log

tests/
├── os-auth-passwords.test.ts
├── os-auth-keys.test.ts
├── os-auth-tokens.test.ts
├── os-auth-registration.test.ts
├── os-auth-login.test.ts
├── os-auth-sessions.test.ts
├── os-auth-audit.test.ts
├── os-auth-routes.test.ts
```

---

## Task 1: Install argon2 dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install argon2**

```bash
bun add argon2
```

- [ ] **Step 2: Verify installation**

```bash
bun -e "const argon2 = require('argon2'); console.log('argon2 loaded:', typeof argon2.hash)"
```

Expected: `argon2 loaded: function`

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lockb
git commit -m "[OS-AUTH] Add argon2 dependency for password hashing"
```

---

## Task 2: Create OS identity schema migration

**Files:**
- Create: `migrations/forest/20260401_os_accounts.sql`

- [ ] **Step 1: Write the migration file**

```sql
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
```

- [ ] **Step 2: Apply the migration**

```bash
bun run migrate --db forest
```

Expected: Migration applied successfully, 2 tables created.

- [ ] **Step 3: Verify tables exist**

```bash
psql -d ellie-forest -c "\dt os_*"
```

Expected: `os_accounts` and `os_auth_methods` listed.

- [ ] **Step 4: Commit**

```bash
git add migrations/forest/20260401_os_accounts.sql
git commit -m "[OS-AUTH] Create os_accounts and os_auth_methods schema"
```

---

## Task 3: Create OS sessions schema migration

**Files:**
- Create: `migrations/forest/20260401_os_sessions.sql`

- [ ] **Step 1: Write the migration file**

```sql
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
```

- [ ] **Step 2: Apply the migration**

```bash
bun run migrate --db forest
```

- [ ] **Step 3: Commit**

```bash
git add migrations/forest/20260401_os_sessions.sql
git commit -m "[OS-AUTH] Create os_sessions schema with token family model"
```

---

## Task 4: Create OS product memberships, consents, and audit log migration

**Files:**
- Create: `migrations/forest/20260401_os_product_memberships.sql`

- [ ] **Step 1: Write the migration file**

```sql
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
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, product, COALESCE(org_id, '00000000-0000-0000-0000-000000000000'))
);

CREATE INDEX idx_os_memberships_account ON os_product_memberships(account_id);
CREATE INDEX idx_os_memberships_product ON os_product_memberships(product, status);

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
```

- [ ] **Step 2: Apply the migration**

```bash
bun run migrate --db forest
```

- [ ] **Step 3: Commit**

```bash
git add migrations/forest/20260401_os_product_memberships.sql
git commit -m "[OS-AUTH] Create product memberships, consents, and audit log schema"
```

---

## Task 5: Type definitions

**Files:**
- Create: `src/os-auth/schema.ts`

- [ ] **Step 1: Write type definitions**

```typescript
/**
 * OS Auth — Type Definitions
 *
 * Mirrors the os_* tables in Forest DB.
 * Used by all os-auth modules for type safety.
 */

export interface OsAccount {
  id: string
  email: string
  email_verified: boolean
  entity_type: 'user' | 'minor' | 'org_service_account'
  display_name: string | null
  password_hash: string | null
  mfa_enabled: boolean
  mfa_secret: string | null
  status: 'active' | 'suspended' | 'pending_verification' | 'deleted'
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

export interface OsAuthMethod {
  id: string
  account_id: string
  method: 'email_password' | 'magic_link' | 'oauth_google' | 'oauth_apple' | 'oauth_microsoft'
  provider_uid: string | null
  metadata: Record<string, unknown>
  created_at: Date
}

export interface OsSession {
  id: string
  account_id: string
  refresh_token: string
  token_family: string
  audience: string[]
  ip_address: string | null
  user_agent: string | null
  expires_at: Date
  revoked_at: Date | null
  created_at: Date
}

export interface OsProductMembership {
  id: string
  account_id: string
  product: string
  roles: string[]
  entitlements: Record<string, unknown>
  org_id: string | null
  status: 'active' | 'suspended' | 'revoked'
  created_at: Date
  updated_at: Date
}

export interface OsAuditEntry {
  id: string
  account_id: string | null
  event_type: string
  product: string | null
  ip_address: string | null
  user_agent: string | null
  metadata: Record<string, unknown>
  created_at: Date
}

/** JWT access token payload — what products decode from the token */
export interface OsAccessTokenPayload {
  sub: string          // account ID
  aud: string          // target product ('life', 'learn')
  iss: 'ellie-os'
  iat: number
  exp: number
  email: string
  entity_type: OsAccount['entity_type']
  memberships: Record<string, {
    roles: string[]
    entitlements: Record<string, unknown>
    org_id?: string
  }>
}
```

- [ ] **Step 2: Commit**

```bash
git add src/os-auth/schema.ts
git commit -m "[OS-AUTH] Add type definitions for OS auth tables"
```

---

## Task 6: Password hashing module

**Files:**
- Create: `src/os-auth/passwords.ts`
- Create: `tests/os-auth-passwords.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect } from "bun:test"
import { hashPassword, verifyPassword } from "../src/os-auth/passwords"

describe("os-auth passwords", () => {
  test("hashPassword returns a string starting with $argon2id$", async () => {
    const hash = await hashPassword("test-password-123")
    expect(hash.startsWith("$argon2id$")).toBe(true)
  })

  test("verifyPassword returns true for correct password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple")
    const result = await verifyPassword("correct-horse-battery-staple", hash)
    expect(result).toBe(true)
  })

  test("verifyPassword returns false for wrong password", async () => {
    const hash = await hashPassword("correct-horse-battery-staple")
    const result = await verifyPassword("wrong-password", hash)
    expect(result).toBe(false)
  })

  test("same password produces different hashes (salt)", async () => {
    const hash1 = await hashPassword("same-password")
    const hash2 = await hashPassword("same-password")
    expect(hash1).not.toBe(hash2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/os-auth-passwords.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * OS Auth — Password Hashing
 *
 * Thin wrapper around argon2id. All password storage goes through here.
 */

import argon2 from "argon2"

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id })
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return argon2.verify(hash, password)
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/os-auth-passwords.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/os-auth/passwords.ts tests/os-auth-passwords.test.ts
git commit -m "[OS-AUTH] Add argon2id password hashing module + tests"
```

---

## Task 7: Audit log module

**Files:**
- Create: `src/os-auth/audit.ts`
- Create: `tests/os-auth-audit.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect } from "bun:test"
import { buildAuditEntry, AUDIT_EVENTS } from "../src/os-auth/audit"

describe("os-auth audit", () => {
  test("buildAuditEntry creates a valid entry with all fields", () => {
    const entry = buildAuditEntry({
      account_id: "acc-123",
      event_type: AUDIT_EVENTS.LOGIN,
      product: "life",
      ip_address: "192.168.1.1",
      user_agent: "Mozilla/5.0",
      metadata: { method: "email_password" },
    })
    expect(entry.account_id).toBe("acc-123")
    expect(entry.event_type).toBe("login")
    expect(entry.product).toBe("life")
    expect(entry.ip_address).toBe("192.168.1.1")
    expect(entry.metadata).toEqual({ method: "email_password" })
  })

  test("buildAuditEntry works with minimal fields", () => {
    const entry = buildAuditEntry({
      event_type: AUDIT_EVENTS.LOGIN_FAILED,
      ip_address: "10.0.0.1",
    })
    expect(entry.account_id).toBeNull()
    expect(entry.event_type).toBe("login_failed")
    expect(entry.product).toBeNull()
  })

  test("AUDIT_EVENTS contains all expected event types", () => {
    expect(AUDIT_EVENTS.LOGIN).toBe("login")
    expect(AUDIT_EVENTS.LOGOUT).toBe("logout")
    expect(AUDIT_EVENTS.TOKEN_REFRESH).toBe("token_refresh")
    expect(AUDIT_EVENTS.PASSWORD_CHANGE).toBe("password_change")
    expect(AUDIT_EVENTS.ACCOUNT_CREATE).toBe("account_create")
    expect(AUDIT_EVENTS.ACCOUNT_DELETE).toBe("account_delete")
    expect(AUDIT_EVENTS.LOGIN_FAILED).toBe("login_failed")
    expect(AUDIT_EVENTS.TOKEN_FAMILY_REVOKED).toBe("token_family_revoked")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/os-auth-audit.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * OS Auth — Audit Log
 *
 * Append-only structured event log for all auth events.
 * writeAudit() inserts to Forest DB; buildAuditEntry() is pure (for testing).
 */

import type { Sql } from "postgres"
import { log } from "../logger.ts"

const logger = log.child("os-auth-audit")

export const AUDIT_EVENTS = {
  LOGIN: "login",
  LOGOUT: "logout",
  LOGIN_FAILED: "login_failed",
  TOKEN_REFRESH: "token_refresh",
  PASSWORD_CHANGE: "password_change",
  MFA_ENROLL: "mfa_enroll",
  PERMISSION_GRANT: "permission_grant",
  PERMISSION_REVOKE: "permission_revoke",
  ACCOUNT_CREATE: "account_create",
  ACCOUNT_DELETE: "account_delete",
  TOKEN_FAMILY_REVOKED: "token_family_revoked",
  EMAIL_VERIFIED: "email_verified",
  MAGIC_LINK_SENT: "magic_link_sent",
} as const

export type AuditEventType = typeof AUDIT_EVENTS[keyof typeof AUDIT_EVENTS]

interface AuditInput {
  account_id?: string | null
  event_type: AuditEventType
  product?: string | null
  ip_address?: string | null
  user_agent?: string | null
  metadata?: Record<string, unknown>
}

interface AuditEntry {
  account_id: string | null
  event_type: string
  product: string | null
  ip_address: string | null
  user_agent: string | null
  metadata: Record<string, unknown>
}

/** Pure function — builds an audit entry without touching the DB. */
export function buildAuditEntry(input: AuditInput): AuditEntry {
  return {
    account_id: input.account_id ?? null,
    event_type: input.event_type,
    product: input.product ?? null,
    ip_address: input.ip_address ?? null,
    user_agent: input.user_agent ?? null,
    metadata: input.metadata ?? {},
  }
}

/** Write an audit entry to Forest DB. Fire-and-forget — never throws. */
export async function writeAudit(sql: Sql, input: AuditInput): Promise<void> {
  const entry = buildAuditEntry(input)
  try {
    await sql`
      INSERT INTO os_audit_log (account_id, event_type, product, ip_address, user_agent, metadata)
      VALUES (${entry.account_id}, ${entry.event_type}, ${entry.product},
              ${entry.ip_address}::inet, ${entry.user_agent}, ${JSON.stringify(entry.metadata)})
    `
  } catch (err) {
    logger.error("Failed to write audit log", { error: err, entry })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/os-auth-audit.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/os-auth/audit.ts tests/os-auth-audit.test.ts
git commit -m "[OS-AUTH] Add audit log module with pure builder + DB writer"
```

---

## Task 8: RS256 key management

**Files:**
- Create: `src/os-auth/keys.ts`
- Create: `tests/os-auth-keys.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect } from "bun:test"
import {
  generateKeyPair,
  publicKeyToJwk,
  buildJwksResponse,
} from "../src/os-auth/keys"

describe("os-auth keys", () => {
  test("generateKeyPair returns PEM-encoded RSA key pair", async () => {
    const { publicKey, privateKey } = await generateKeyPair()
    expect(publicKey).toContain("-----BEGIN PUBLIC KEY-----")
    expect(privateKey).toContain("-----BEGIN PRIVATE KEY-----")
  })

  test("publicKeyToJwk converts PEM to JWK format", async () => {
    const { publicKey } = await generateKeyPair()
    const jwk = publicKeyToJwk(publicKey, "test-kid-1")
    expect(jwk.kty).toBe("RSA")
    expect(jwk.alg).toBe("RS256")
    expect(jwk.use).toBe("sig")
    expect(jwk.kid).toBe("test-kid-1")
    expect(jwk.n).toBeDefined()
    expect(jwk.e).toBeDefined()
  })

  test("buildJwksResponse wraps JWK in standard JWKS format", async () => {
    const { publicKey } = await generateKeyPair()
    const jwk = publicKeyToJwk(publicKey, "kid-1")
    const jwks = buildJwksResponse([jwk])
    expect(jwks.keys).toHaveLength(1)
    expect(jwks.keys[0].kid).toBe("kid-1")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/os-auth-keys.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * OS Auth — RS256 Key Management
 *
 * Generates RSA key pairs, converts to JWK for JWKS endpoint,
 * and loads/stores keys via The Hollow (encrypted vault).
 *
 * Key ID (kid) format: "os-auth-{timestamp}" — allows rotation.
 */

import { generateKeyPairSync, createPublicKey } from "crypto"
import { log } from "../logger.ts"

const logger = log.child("os-auth-keys")

interface RsaKeyPair {
  publicKey: string   // PEM
  privateKey: string  // PEM
}

interface Jwk {
  kty: "RSA"
  alg: "RS256"
  use: "sig"
  kid: string
  n: string
  e: string
}

interface JwksResponse {
  keys: Jwk[]
}

/** Generate a new RS256 key pair (2048-bit RSA). */
export async function generateKeyPair(): Promise<RsaKeyPair> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
  return { publicKey: publicKey as string, privateKey: privateKey as string }
}

/** Convert a PEM public key to JWK format for the JWKS endpoint. */
export function publicKeyToJwk(publicKeyPem: string, kid: string): Jwk {
  const keyObject = createPublicKey(publicKeyPem)
  const jwk = keyObject.export({ format: "jwk" }) as { n: string; e: string }
  return {
    kty: "RSA",
    alg: "RS256",
    use: "sig",
    kid,
    n: jwk.n,
    e: jwk.e,
  }
}

/** Build a standard JWKS response (for /.well-known/jwks.json). */
export function buildJwksResponse(jwks: Jwk[]): JwksResponse {
  return { keys: jwks }
}

// ── Key Loading (from Hollow) ───────────────────────────────

let _cachedPrivateKey: string | null = null
let _cachedPublicKey: string | null = null
let _cachedKid: string | null = null

const OS_AUTH_KEYCHAIN_ID = "os-auth-signing-keys"

/**
 * Load or generate the signing key pair.
 * On first call: checks The Hollow for existing keys. If none, generates + stores.
 * Subsequent calls return cached keys.
 */
export async function getSigningKeys(opts: {
  retrieveSecret: (keychainId: string, key: string) => Promise<string | null>
  storeSecret?: (keychainId: string, key: string, value: string) => Promise<void>
}): Promise<{ privateKey: string; publicKey: string; kid: string }> {
  if (_cachedPrivateKey && _cachedPublicKey && _cachedKid) {
    return { privateKey: _cachedPrivateKey, publicKey: _cachedPublicKey, kid: _cachedKid }
  }

  // Try loading from Hollow
  const storedPrivate = await opts.retrieveSecret(OS_AUTH_KEYCHAIN_ID, "private_key")
  const storedPublic = await opts.retrieveSecret(OS_AUTH_KEYCHAIN_ID, "public_key")
  const storedKid = await opts.retrieveSecret(OS_AUTH_KEYCHAIN_ID, "kid")

  if (storedPrivate && storedPublic && storedKid) {
    _cachedPrivateKey = storedPrivate
    _cachedPublicKey = storedPublic
    _cachedKid = storedKid
    logger.info("Loaded OS auth signing keys from Hollow", { kid: storedKid })
    return { privateKey: storedPrivate, publicKey: storedPublic, kid: storedKid }
  }

  // Generate new key pair
  const { publicKey, privateKey } = await generateKeyPair()
  const kid = `os-auth-${Date.now()}`

  if (opts.storeSecret) {
    await opts.storeSecret(OS_AUTH_KEYCHAIN_ID, "private_key", privateKey)
    await opts.storeSecret(OS_AUTH_KEYCHAIN_ID, "public_key", publicKey)
    await opts.storeSecret(OS_AUTH_KEYCHAIN_ID, "kid", kid)
    logger.info("Generated and stored new OS auth signing keys", { kid })
  }

  _cachedPrivateKey = privateKey
  _cachedPublicKey = publicKey
  _cachedKid = kid
  return { privateKey, publicKey, kid }
}

/** Reset cached keys — for testing only. */
export function _resetKeyCache(): void {
  _cachedPrivateKey = null
  _cachedPublicKey = null
  _cachedKid = null
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/os-auth-keys.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/os-auth/keys.ts tests/os-auth-keys.test.ts
git commit -m "[OS-AUTH] Add RS256 key management with Hollow integration + JWKS builder"
```

---

## Task 9: Token issuance and verification

**Files:**
- Create: `src/os-auth/tokens.ts`
- Create: `tests/os-auth-tokens.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect } from "bun:test"
import {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
  ACCESS_TOKEN_EXPIRY_SECONDS,
} from "../src/os-auth/tokens"
import { generateKeyPair } from "../src/os-auth/keys"

describe("os-auth tokens", () => {
  let privateKey: string
  let publicKey: string
  const kid = "test-kid-1"

  // Generate a key pair for all tests
  const keyPairPromise = generateKeyPair()

  test("signAccessToken creates a valid JWT", async () => {
    const { privateKey: pk, publicKey: pub } = await keyPairPromise
    privateKey = pk
    publicKey = pub

    const token = await signAccessToken({
      privateKey,
      kid,
      accountId: "acc-uuid-1",
      email: "dave@example.com",
      entityType: "user",
      audience: "life",
      memberships: {
        life: { roles: ["pro"], entitlements: { tier: "pro" } },
      },
    })

    expect(typeof token).toBe("string")
    expect(token.split(".")).toHaveLength(3) // header.payload.signature
  })

  test("verifyAccessToken decodes a valid token", async () => {
    const { privateKey: pk, publicKey: pub } = await keyPairPromise
    privateKey = pk
    publicKey = pub

    const token = await signAccessToken({
      privateKey,
      kid,
      accountId: "acc-uuid-1",
      email: "dave@example.com",
      entityType: "user",
      audience: "life",
      memberships: {
        life: { roles: ["pro"], entitlements: { tier: "pro" } },
      },
    })

    const payload = verifyAccessToken(token, publicKey, "life")
    expect(payload).not.toBeNull()
    expect(payload!.sub).toBe("acc-uuid-1")
    expect(payload!.aud).toBe("life")
    expect(payload!.iss).toBe("ellie-os")
    expect(payload!.email).toBe("dave@example.com")
    expect(payload!.memberships.life.roles).toEqual(["pro"])
  })

  test("verifyAccessToken rejects token with wrong audience", async () => {
    const { privateKey: pk, publicKey: pub } = await keyPairPromise
    privateKey = pk
    publicKey = pub

    const token = await signAccessToken({
      privateKey,
      kid,
      accountId: "acc-uuid-1",
      email: "dave@example.com",
      entityType: "user",
      audience: "life",
      memberships: {},
    })

    const payload = verifyAccessToken(token, publicKey, "learn")
    expect(payload).toBeNull()
  })

  test("verifyAccessToken rejects expired token", async () => {
    const { privateKey: pk, publicKey: pub } = await keyPairPromise
    privateKey = pk
    publicKey = pub

    const token = await signAccessToken({
      privateKey,
      kid,
      accountId: "acc-uuid-1",
      email: "dave@example.com",
      entityType: "user",
      audience: "life",
      memberships: {},
      expiresInSeconds: -10, // already expired
    })

    const payload = verifyAccessToken(token, publicKey, "life")
    expect(payload).toBeNull()
  })

  test("generateRefreshToken returns a 64-char hex string prefixed with osrt_", () => {
    const token = generateRefreshToken()
    expect(token.startsWith("osrt_")).toBe(true)
    expect(token.length).toBe(5 + 64) // "osrt_" + 32 bytes hex
  })

  test("ACCESS_TOKEN_EXPIRY_SECONDS is 900 (15 minutes)", () => {
    expect(ACCESS_TOKEN_EXPIRY_SECONDS).toBe(900)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/os-auth-tokens.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * OS Auth — Token Issuance & Verification
 *
 * Access tokens: RS256 JWTs, 15-min expiry, audience-scoped.
 * Refresh tokens: opaque random strings prefixed with "osrt_".
 */

import jwt from "jsonwebtoken"
import { randomBytes } from "crypto"
import type { OsAccessTokenPayload, OsAccount } from "./schema"

export const ACCESS_TOKEN_EXPIRY_SECONDS = 900 // 15 minutes
export const REFRESH_TOKEN_EXPIRY_DAYS = 30

interface SignAccessTokenInput {
  privateKey: string
  kid: string
  accountId: string
  email: string
  entityType: OsAccount['entity_type']
  audience: string
  memberships: OsAccessTokenPayload['memberships']
  expiresInSeconds?: number
}

/** Sign an RS256 access token. */
export async function signAccessToken(input: SignAccessTokenInput): Promise<string> {
  const payload = {
    sub: input.accountId,
    email: input.email,
    entity_type: input.entityType,
    memberships: input.memberships,
  }

  return jwt.sign(payload, input.privateKey, {
    algorithm: "RS256",
    expiresIn: input.expiresInSeconds ?? ACCESS_TOKEN_EXPIRY_SECONDS,
    audience: input.audience,
    issuer: "ellie-os",
    keyid: input.kid,
  })
}

/** Verify an access token against the public key and expected audience. Returns null if invalid. */
export function verifyAccessToken(
  token: string,
  publicKey: string,
  expectedAudience: string,
): OsAccessTokenPayload | null {
  try {
    const decoded = jwt.verify(token, publicKey, {
      algorithms: ["RS256"],
      audience: expectedAudience,
      issuer: "ellie-os",
    }) as OsAccessTokenPayload
    return decoded
  } catch {
    return null
  }
}

/** Generate an opaque refresh token. */
export function generateRefreshToken(): string {
  return "osrt_" + randomBytes(32).toString("hex")
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/os-auth-tokens.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/os-auth/tokens.ts tests/os-auth-tokens.test.ts
git commit -m "[OS-AUTH] Add RS256 token issuance and verification + tests"
```

---

## Task 10: Session management (token families + rotation detection)

**Files:**
- Create: `src/os-auth/sessions.ts`
- Create: `tests/os-auth-sessions.test.ts`

- [ ] **Step 1: Write the failing test**

The session module has DB-dependent functions. We test the pure logic and the SQL-injected functions separately. This test focuses on the pure helpers and the SQL-parameterized functions using a mock.

```typescript
import { describe, test, expect } from "bun:test"
import {
  buildNewSession,
  isSessionExpired,
  isSessionRevoked,
  REFRESH_TOKEN_EXPIRY_DAYS,
} from "../src/os-auth/sessions"

describe("os-auth sessions — pure helpers", () => {
  test("buildNewSession creates session with token family and expiry", () => {
    const session = buildNewSession({
      accountId: "acc-1",
      refreshToken: "osrt_abc123",
      audience: ["life"],
      ipAddress: "192.168.1.1",
      userAgent: "TestAgent/1.0",
    })

    expect(session.account_id).toBe("acc-1")
    expect(session.refresh_token).toBe("osrt_abc123")
    expect(session.token_family).toBeDefined()
    expect(typeof session.token_family).toBe("string")
    expect(session.audience).toEqual(["life"])
    expect(session.ip_address).toBe("192.168.1.1")
    expect(session.user_agent).toBe("TestAgent/1.0")
    expect(session.revoked_at).toBeNull()

    // Expiry should be ~30 days from now
    const expectedExpiry = Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000
    const diff = Math.abs(session.expires_at.getTime() - expectedExpiry)
    expect(diff).toBeLessThan(5000) // within 5 seconds
  })

  test("buildNewSession with explicit token_family (rotation)", () => {
    const session = buildNewSession({
      accountId: "acc-1",
      refreshToken: "osrt_new",
      audience: ["life"],
      tokenFamily: "family-uuid-123",
    })

    expect(session.token_family).toBe("family-uuid-123")
  })

  test("isSessionExpired returns true for past expiry", () => {
    const session = { expires_at: new Date(Date.now() - 1000), revoked_at: null }
    expect(isSessionExpired(session)).toBe(true)
  })

  test("isSessionExpired returns false for future expiry", () => {
    const session = { expires_at: new Date(Date.now() + 60000), revoked_at: null }
    expect(isSessionExpired(session)).toBe(false)
  })

  test("isSessionRevoked returns true when revoked_at is set", () => {
    expect(isSessionRevoked({ revoked_at: new Date() })).toBe(true)
  })

  test("isSessionRevoked returns false when revoked_at is null", () => {
    expect(isSessionRevoked({ revoked_at: null })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/os-auth-sessions.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * OS Auth — Session Management
 *
 * Manages refresh token sessions with token family rotation detection.
 * When a refresh token is reused after rotation, the entire family is revoked
 * (indicates token theft — see design doc §4.2).
 */

import { randomUUID } from "crypto"
import type { Sql } from "postgres"
import type { OsSession } from "./schema"
import { generateRefreshToken } from "./tokens"
import { writeAudit, AUDIT_EVENTS } from "./audit"
import { log } from "../logger.ts"

const logger = log.child("os-auth-sessions")

export const REFRESH_TOKEN_EXPIRY_DAYS = 30

// ── Pure Helpers ────────────────────────────────────────────

interface NewSessionInput {
  accountId: string
  refreshToken: string
  audience: string[]
  tokenFamily?: string
  ipAddress?: string | null
  userAgent?: string | null
}

interface SessionLike {
  expires_at: Date
  revoked_at: Date | null
}

export function buildNewSession(input: NewSessionInput) {
  return {
    account_id: input.accountId,
    refresh_token: input.refreshToken,
    token_family: input.tokenFamily ?? randomUUID(),
    audience: input.audience,
    ip_address: input.ipAddress ?? null,
    user_agent: input.userAgent ?? null,
    expires_at: new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
    revoked_at: null,
  }
}

export function isSessionExpired(session: Pick<SessionLike, 'expires_at'>): boolean {
  return session.expires_at.getTime() < Date.now()
}

export function isSessionRevoked(session: Pick<SessionLike, 'revoked_at'>): boolean {
  return session.revoked_at !== null
}

// ── DB Operations ───────────────────────────────────────────

/** Create a new session row in the database. */
export async function createSession(
  sql: Sql,
  input: NewSessionInput,
): Promise<OsSession> {
  const s = buildNewSession(input)
  const [row] = await sql<OsSession[]>`
    INSERT INTO os_sessions (account_id, refresh_token, token_family, audience, ip_address, user_agent, expires_at)
    VALUES (${s.account_id}, ${s.refresh_token}, ${s.token_family}, ${sql.array(s.audience)},
            ${s.ip_address}::inet, ${s.user_agent}, ${s.expires_at})
    RETURNING *
  `
  return row
}

/** Look up a session by refresh token. */
export async function findSessionByRefreshToken(
  sql: Sql,
  refreshToken: string,
): Promise<OsSession | null> {
  const [row] = await sql<OsSession[]>`
    SELECT * FROM os_sessions WHERE refresh_token = ${refreshToken}
  `
  return row ?? null
}

/**
 * Rotate a refresh token: revoke the old session, create a new one in the same family.
 * Returns the new session, or null if the old token is invalid/revoked/expired.
 *
 * If the old token was already revoked (replay attack), revokes the ENTIRE family.
 */
export async function rotateRefreshToken(
  sql: Sql,
  oldRefreshToken: string,
  opts?: { ipAddress?: string; userAgent?: string },
): Promise<{ session: OsSession; replayDetected: false } | { session: null; replayDetected: boolean }> {
  const oldSession = await findSessionByRefreshToken(sql, oldRefreshToken)

  if (!oldSession) {
    return { session: null, replayDetected: false }
  }

  // Replay detection: if this token was already revoked, someone stole it
  if (isSessionRevoked(oldSession)) {
    logger.warn("Refresh token replay detected — revoking entire family", {
      token_family: oldSession.token_family,
      account_id: oldSession.account_id,
    })
    await revokeFamilySessions(sql, oldSession.token_family)
    await writeAudit(sql, {
      account_id: oldSession.account_id,
      event_type: AUDIT_EVENTS.TOKEN_FAMILY_REVOKED,
      ip_address: opts?.ipAddress,
      metadata: { reason: "replay_detected", token_family: oldSession.token_family },
    })
    return { session: null, replayDetected: true }
  }

  if (isSessionExpired(oldSession)) {
    return { session: null, replayDetected: false }
  }

  // Revoke the old token
  await sql`
    UPDATE os_sessions SET revoked_at = now() WHERE id = ${oldSession.id}
  `

  // Issue a new token in the same family
  const newRefreshToken = generateRefreshToken()
  const newSession = await createSession(sql, {
    accountId: oldSession.account_id,
    refreshToken: newRefreshToken,
    audience: oldSession.audience,
    tokenFamily: oldSession.token_family,
    ipAddress: opts?.ipAddress,
    userAgent: opts?.userAgent,
  })

  return { session: newSession, replayDetected: false }
}

/** Revoke all sessions in a token family. */
export async function revokeFamilySessions(sql: Sql, tokenFamily: string): Promise<number> {
  const result = await sql`
    UPDATE os_sessions SET revoked_at = now()
    WHERE token_family = ${tokenFamily} AND revoked_at IS NULL
  `
  return result.count
}

/** Revoke all sessions for an account (e.g., on logout-everywhere or password change). */
export async function revokeAllAccountSessions(sql: Sql, accountId: string): Promise<number> {
  const result = await sql`
    UPDATE os_sessions SET revoked_at = now()
    WHERE account_id = ${accountId} AND revoked_at IS NULL
  `
  return result.count
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/os-auth-sessions.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/os-auth/sessions.ts tests/os-auth-sessions.test.ts
git commit -m "[OS-AUTH] Add session management with token family rotation detection"
```

---

## Task 11: Registration endpoint

**Files:**
- Create: `src/os-auth/registration.ts`
- Create: `tests/os-auth-registration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect } from "bun:test"
import { validateRegistrationInput } from "../src/os-auth/registration"

describe("os-auth registration — input validation", () => {
  test("rejects missing email", () => {
    const result = validateRegistrationInput({ password: "secure-pass-123" })
    expect(result.valid).toBe(false)
    expect(result.error).toBe("Email is required")
  })

  test("rejects invalid email", () => {
    const result = validateRegistrationInput({ email: "not-an-email", password: "secure-pass-123" })
    expect(result.valid).toBe(false)
    expect(result.error).toBe("Invalid email format")
  })

  test("rejects missing password", () => {
    const result = validateRegistrationInput({ email: "dave@example.com" })
    expect(result.valid).toBe(false)
    expect(result.error).toBe("Password is required")
  })

  test("rejects short password (under 8 chars)", () => {
    const result = validateRegistrationInput({ email: "dave@example.com", password: "short" })
    expect(result.valid).toBe(false)
    expect(result.error).toBe("Password must be at least 8 characters")
  })

  test("accepts valid input", () => {
    const result = validateRegistrationInput({
      email: "dave@example.com",
      password: "secure-password-123",
      display_name: "Dave",
    })
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.email).toBe("dave@example.com")
    expect(result.display_name).toBe("Dave")
  })

  test("normalizes email to lowercase", () => {
    const result = validateRegistrationInput({
      email: "Dave@Example.COM",
      password: "secure-password-123",
    })
    expect(result.valid).toBe(true)
    expect(result.email).toBe("dave@example.com")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/os-auth-registration.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * OS Auth — Registration
 *
 * Account creation with email + password. Accounts start as
 * 'pending_verification' until email is confirmed.
 */

import type { Sql } from "postgres"
import type { OsAccount } from "./schema"
import { hashPassword } from "./passwords"
import { writeAudit, AUDIT_EVENTS } from "./audit"
import { log } from "../logger.ts"

const logger = log.child("os-auth-registration")

// ── Input Validation (pure) ─────────────────────────────────

interface RegistrationInput {
  email?: unknown
  password?: unknown
  display_name?: unknown
  entity_type?: unknown
}

interface ValidationResult {
  valid: boolean
  error?: string
  email?: string
  password?: string
  display_name?: string | null
  entity_type?: OsAccount['entity_type']
}

export function validateRegistrationInput(input: RegistrationInput): ValidationResult {
  if (!input.email || typeof input.email !== "string") {
    return { valid: false, error: "Email is required" }
  }

  const email = input.email.toLowerCase().trim()
  if (!email.includes("@") || !email.includes(".")) {
    return { valid: false, error: "Invalid email format" }
  }

  if (!input.password || typeof input.password !== "string") {
    return { valid: false, error: "Password is required" }
  }

  if (input.password.length < 8) {
    return { valid: false, error: "Password must be at least 8 characters" }
  }

  const entity_type = (input.entity_type as OsAccount['entity_type']) || "user"
  const display_name = typeof input.display_name === "string" ? input.display_name.trim() || null : null

  return { valid: true, email, password: input.password, display_name, entity_type }
}

// ── DB Operations ───────────────────────────────────────────

interface RegisterResult {
  ok: boolean
  account?: OsAccount
  error?: string
}

/**
 * Register a new account.
 * Returns the created account (status: pending_verification).
 * Fails if email already exists.
 */
export async function registerAccount(
  sql: Sql,
  input: { email: string; password: string; display_name?: string | null; entity_type?: OsAccount['entity_type'] },
  opts?: { ipAddress?: string; userAgent?: string },
): Promise<RegisterResult> {
  const passwordHash = await hashPassword(input.password)

  try {
    const [account] = await sql<OsAccount[]>`
      INSERT INTO os_accounts (email, display_name, password_hash, entity_type, status)
      VALUES (${input.email}, ${input.display_name ?? null}, ${passwordHash},
              ${input.entity_type ?? 'user'}, 'pending_verification')
      RETURNING *
    `

    // Record auth method
    await sql`
      INSERT INTO os_auth_methods (account_id, method)
      VALUES (${account.id}, 'email_password')
    `

    await writeAudit(sql, {
      account_id: account.id,
      event_type: AUDIT_EVENTS.ACCOUNT_CREATE,
      ip_address: opts?.ipAddress,
      user_agent: opts?.userAgent,
      metadata: { method: "email_password", entity_type: input.entity_type ?? "user" },
    })

    logger.info("Account registered", { accountId: account.id, email: input.email })
    return { ok: true, account }
  } catch (err: any) {
    if (err?.code === "23505") { // unique_violation
      return { ok: false, error: "An account with this email already exists" }
    }
    throw err
  }
}

/**
 * Verify an account's email (mark as active).
 * Called after email verification code is confirmed.
 */
export async function verifyAccountEmail(
  sql: Sql,
  accountId: string,
  opts?: { ipAddress?: string },
): Promise<boolean> {
  const result = await sql`
    UPDATE os_accounts
    SET email_verified = true, status = 'active', updated_at = now()
    WHERE id = ${accountId} AND status = 'pending_verification'
  `

  if (result.count > 0) {
    await writeAudit(sql, {
      account_id: accountId,
      event_type: AUDIT_EVENTS.EMAIL_VERIFIED,
      ip_address: opts?.ipAddress,
    })
    return true
  }
  return false
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/os-auth-registration.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/os-auth/registration.ts tests/os-auth-registration.test.ts
git commit -m "[OS-AUTH] Add registration with input validation and account creation"
```

---

## Task 12: Login endpoint

**Files:**
- Create: `src/os-auth/login.ts`
- Create: `tests/os-auth-login.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect } from "bun:test"
import { validateLoginInput } from "../src/os-auth/login"

describe("os-auth login — input validation", () => {
  test("rejects missing email", () => {
    const result = validateLoginInput({ password: "pass" })
    expect(result.valid).toBe(false)
    expect(result.error).toBe("Email is required")
  })

  test("rejects missing password", () => {
    const result = validateLoginInput({ email: "dave@example.com" })
    expect(result.valid).toBe(false)
    expect(result.error).toBe("Password is required")
  })

  test("accepts valid credentials", () => {
    const result = validateLoginInput({ email: "Dave@Example.COM", password: "password123" })
    expect(result.valid).toBe(true)
    expect(result.email).toBe("dave@example.com")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/os-auth-login.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * OS Auth — Login
 *
 * Email/password authentication. On success, creates a session and
 * returns access + refresh tokens.
 */

import type { Sql } from "postgres"
import type { OsAccount, OsAccessTokenPayload } from "./schema"
import { verifyPassword } from "./passwords"
import { signAccessToken, generateRefreshToken } from "./tokens"
import { createSession } from "./sessions"
import { writeAudit, AUDIT_EVENTS } from "./audit"
import { log } from "../logger.ts"

const logger = log.child("os-auth-login")

// ── Input Validation (pure) ─────────────────────────────────

interface LoginInput {
  email?: unknown
  password?: unknown
  audience?: unknown
}

interface LoginValidation {
  valid: boolean
  error?: string
  email?: string
  password?: string
  audience?: string
}

export function validateLoginInput(input: LoginInput): LoginValidation {
  if (!input.email || typeof input.email !== "string") {
    return { valid: false, error: "Email is required" }
  }

  if (!input.password || typeof input.password !== "string") {
    return { valid: false, error: "Password is required" }
  }

  const email = input.email.toLowerCase().trim()
  const audience = typeof input.audience === "string" ? input.audience : "life"

  return { valid: true, email, password: input.password, audience }
}

// ── Login Logic ─────────────────────────────────────────────

interface LoginResult {
  ok: boolean
  accessToken?: string
  refreshToken?: string
  account?: Pick<OsAccount, 'id' | 'email' | 'display_name' | 'entity_type'>
  error?: string
}

/**
 * Authenticate with email + password.
 * Returns access token + refresh token + session on success.
 */
export async function loginWithPassword(
  sql: Sql,
  input: { email: string; password: string; audience: string },
  signingKeys: { privateKey: string; kid: string },
  opts?: { ipAddress?: string; userAgent?: string },
): Promise<LoginResult> {
  // Look up account
  const [account] = await sql<OsAccount[]>`
    SELECT * FROM os_accounts
    WHERE email = ${input.email} AND status != 'deleted'
  `

  if (!account) {
    await writeAudit(sql, {
      event_type: AUDIT_EVENTS.LOGIN_FAILED,
      ip_address: opts?.ipAddress,
      metadata: { reason: "account_not_found", email: input.email },
    })
    return { ok: false, error: "Invalid email or password" }
  }

  if (account.status === "suspended") {
    return { ok: false, error: "Account is suspended" }
  }

  if (!account.password_hash) {
    return { ok: false, error: "Invalid email or password" }
  }

  // Verify password
  const passwordValid = await verifyPassword(input.password, account.password_hash)
  if (!passwordValid) {
    await writeAudit(sql, {
      account_id: account.id,
      event_type: AUDIT_EVENTS.LOGIN_FAILED,
      ip_address: opts?.ipAddress,
      metadata: { reason: "wrong_password" },
    })
    return { ok: false, error: "Invalid email or password" }
  }

  // Load product memberships for token
  const memberships = await sql<{ product: string; roles: string[]; entitlements: Record<string, unknown>; org_id: string | null }[]>`
    SELECT product, roles, entitlements, org_id
    FROM os_product_memberships
    WHERE account_id = ${account.id} AND status = 'active'
  `

  const membershipMap: OsAccessTokenPayload['memberships'] = {}
  for (const m of memberships) {
    membershipMap[m.product] = {
      roles: m.roles,
      entitlements: m.entitlements,
      ...(m.org_id ? { org_id: m.org_id } : {}),
    }
  }

  // Sign access token
  const accessToken = await signAccessToken({
    privateKey: signingKeys.privateKey,
    kid: signingKeys.kid,
    accountId: account.id,
    email: account.email,
    entityType: account.entity_type,
    audience: input.audience,
    memberships: membershipMap,
  })

  // Create refresh token + session
  const refreshToken = generateRefreshToken()
  await createSession(sql, {
    accountId: account.id,
    refreshToken,
    audience: [input.audience],
    ipAddress: opts?.ipAddress,
    userAgent: opts?.userAgent,
  })

  await writeAudit(sql, {
    account_id: account.id,
    event_type: AUDIT_EVENTS.LOGIN,
    product: input.audience,
    ip_address: opts?.ipAddress,
    user_agent: opts?.userAgent,
    metadata: { method: "email_password" },
  })

  logger.info("Login successful", { accountId: account.id })
  return {
    ok: true,
    accessToken,
    refreshToken,
    account: {
      id: account.id,
      email: account.email,
      display_name: account.display_name,
      entity_type: account.entity_type,
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/os-auth-login.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/os-auth/login.ts tests/os-auth-login.test.ts
git commit -m "[OS-AUTH] Add login with password verification and token issuance"
```

---

## Task 13: Product membership helpers

**Files:**
- Create: `src/os-auth/memberships.ts`

- [ ] **Step 1: Write the implementation**

```typescript
/**
 * OS Auth — Product Memberships
 *
 * Read/write helpers for os_product_memberships.
 * Products call these to manage roles and entitlements.
 */

import type { Sql } from "postgres"
import type { OsProductMembership } from "./schema"

/** Get all active memberships for an account. */
export async function getAccountMemberships(
  sql: Sql,
  accountId: string,
): Promise<OsProductMembership[]> {
  return sql<OsProductMembership[]>`
    SELECT * FROM os_product_memberships
    WHERE account_id = ${accountId} AND status = 'active'
    ORDER BY product
  `
}

/** Get membership for a specific account + product (+ optional org). */
export async function getMembership(
  sql: Sql,
  accountId: string,
  product: string,
  orgId?: string | null,
): Promise<OsProductMembership | null> {
  const [row] = orgId
    ? await sql<OsProductMembership[]>`
        SELECT * FROM os_product_memberships
        WHERE account_id = ${accountId} AND product = ${product} AND org_id = ${orgId}
      `
    : await sql<OsProductMembership[]>`
        SELECT * FROM os_product_memberships
        WHERE account_id = ${accountId} AND product = ${product} AND org_id IS NULL
      `
  return row ?? null
}

/** Create or update a product membership. */
export async function upsertMembership(
  sql: Sql,
  input: {
    accountId: string
    product: string
    roles: string[]
    entitlements?: Record<string, unknown>
    orgId?: string | null
  },
): Promise<OsProductMembership> {
  const nullableOrgId = input.orgId ?? null
  const coalesceOrgId = nullableOrgId ?? "00000000-0000-0000-0000-000000000000"

  const [row] = await sql<OsProductMembership[]>`
    INSERT INTO os_product_memberships (account_id, product, roles, entitlements, org_id)
    VALUES (${input.accountId}, ${input.product}, ${sql.array(input.roles)},
            ${JSON.stringify(input.entitlements ?? {})}, ${nullableOrgId})
    ON CONFLICT (account_id, product, COALESCE(org_id, '00000000-0000-0000-0000-000000000000'))
    DO UPDATE SET
      roles = EXCLUDED.roles,
      entitlements = EXCLUDED.entitlements,
      status = 'active',
      updated_at = now()
    RETURNING *
  `
  return row
}
```

- [ ] **Step 2: Commit**

```bash
git add src/os-auth/memberships.ts
git commit -m "[OS-AUTH] Add product membership read/write helpers"
```

---

## Task 14: Route dispatcher + JWKS endpoint

**Files:**
- Create: `src/os-auth/index.ts`
- Create: `tests/os-auth-routes.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect } from "bun:test"
import {
  parseOsAuthRoute,
  type OsAuthRouteMatch,
} from "../src/os-auth/index"

describe("os-auth route parsing", () => {
  test("matches POST /api/os-auth/register", () => {
    const match = parseOsAuthRoute("/api/os-auth/register", "POST")
    expect(match).toEqual({ handler: "register", method: "POST" })
  })

  test("matches POST /api/os-auth/login", () => {
    const match = parseOsAuthRoute("/api/os-auth/login", "POST")
    expect(match).toEqual({ handler: "login", method: "POST" })
  })

  test("matches POST /api/os-auth/refresh", () => {
    const match = parseOsAuthRoute("/api/os-auth/refresh", "POST")
    expect(match).toEqual({ handler: "refresh", method: "POST" })
  })

  test("matches GET /api/os-auth/me", () => {
    const match = parseOsAuthRoute("/api/os-auth/me", "GET")
    expect(match).toEqual({ handler: "me", method: "GET" })
  })

  test("matches GET /.well-known/jwks.json", () => {
    const match = parseOsAuthRoute("/.well-known/jwks.json", "GET")
    expect(match).toEqual({ handler: "jwks", method: "GET" })
  })

  test("returns null for non-matching routes", () => {
    expect(parseOsAuthRoute("/api/bridge/read", "POST")).toBeNull()
    expect(parseOsAuthRoute("/api/os-auth/register", "GET")).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/os-auth-routes.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * OS Auth — Route Dispatcher
 *
 * Wires all OS auth endpoints into the relay HTTP handler.
 * Called from http-routes.ts when pathname starts with /api/os-auth/
 * or is /.well-known/jwks.json.
 *
 * Endpoints:
 *   POST /api/os-auth/register  — create account
 *   POST /api/os-auth/login     — email/password login
 *   POST /api/os-auth/refresh   — rotate refresh token
 *   GET  /api/os-auth/me        — get current account from access token
 *   POST /api/os-auth/logout    — revoke session
 *   GET  /.well-known/jwks.json — public key for token verification
 */

import type { Sql } from "postgres"
import type { ApiRequest, ApiResponse } from "../api/types.ts"
import { validateRegistrationInput, registerAccount, verifyAccountEmail } from "./registration"
import { validateLoginInput, loginWithPassword } from "./login"
import { rotateRefreshToken, revokeAllAccountSessions, findSessionByRefreshToken } from "./sessions"
import { signAccessToken, verifyAccessToken, generateRefreshToken } from "./tokens"
import { getSigningKeys, publicKeyToJwk, buildJwksResponse, _resetKeyCache } from "./keys"
import { getAccountMemberships } from "./memberships"
import { writeAudit, AUDIT_EVENTS } from "./audit"
import type { OsAccessTokenPayload } from "./schema"
import { log } from "../logger.ts"

const logger = log.child("os-auth")

// ── Route Parsing (pure) ────────────────────────────────────

export interface OsAuthRouteMatch {
  handler: "register" | "login" | "refresh" | "me" | "logout" | "jwks"
  method: string
}

export function parseOsAuthRoute(pathname: string, method: string): OsAuthRouteMatch | null {
  if (pathname === "/.well-known/jwks.json" && method === "GET") {
    return { handler: "jwks", method }
  }

  if (!pathname.startsWith("/api/os-auth/")) return null

  const endpoint = pathname.slice("/api/os-auth/".length)

  switch (endpoint) {
    case "register":
      return method === "POST" ? { handler: "register", method } : null
    case "login":
      return method === "POST" ? { handler: "login", method } : null
    case "refresh":
      return method === "POST" ? { handler: "refresh", method } : null
    case "me":
      return method === "GET" ? { handler: "me", method } : null
    case "logout":
      return method === "POST" ? { handler: "logout", method } : null
    default:
      return null
  }
}

// ── Route Handler ───────────────────────────────────────────

interface OsAuthDeps {
  sql: Sql
  retrieveSecret: (keychainId: string, key: string) => Promise<string | null>
  storeSecret?: (keychainId: string, key: string, value: string) => Promise<void>
}

/**
 * Main route handler — call from http-routes.ts.
 * Returns true if the route was handled, false if not an os-auth route.
 */
export async function handleOsAuthRoute(
  req: ApiRequest & { headers?: Record<string, string> },
  res: ApiResponse,
  pathname: string,
  method: string,
  deps: OsAuthDeps,
): Promise<boolean> {
  const match = parseOsAuthRoute(pathname, method)
  if (!match) return false

  const ipAddress = req.headers?.["x-forwarded-for"] || req.headers?.["x-real-ip"] || null
  const userAgent = req.headers?.["user-agent"] || null

  try {
    switch (match.handler) {
      case "jwks": {
        const keys = await getSigningKeys(deps)
        const jwk = publicKeyToJwk(keys.publicKey, keys.kid)
        res.json(buildJwksResponse([jwk]))
        return true
      }

      case "register": {
        const validation = validateRegistrationInput(req.body ?? {})
        if (!validation.valid) {
          res.status(400).json({ error: validation.error })
          return true
        }
        const result = await registerAccount(deps.sql, {
          email: validation.email!,
          password: validation.password!,
          display_name: validation.display_name,
          entity_type: validation.entity_type,
        }, { ipAddress: ipAddress ?? undefined, userAgent: userAgent ?? undefined })

        if (!result.ok) {
          res.status(409).json({ error: result.error })
          return true
        }
        res.status(201).json({
          ok: true,
          account: {
            id: result.account!.id,
            email: result.account!.email,
            display_name: result.account!.display_name,
            status: result.account!.status,
          },
        })
        return true
      }

      case "login": {
        const validation = validateLoginInput(req.body ?? {})
        if (!validation.valid) {
          res.status(400).json({ error: validation.error })
          return true
        }
        const keys = await getSigningKeys(deps)
        const result = await loginWithPassword(deps.sql, {
          email: validation.email!,
          password: validation.password!,
          audience: validation.audience!,
        }, keys, { ipAddress: ipAddress ?? undefined, userAgent: userAgent ?? undefined })

        if (!result.ok) {
          res.status(401).json({ error: result.error })
          return true
        }
        res.json({
          ok: true,
          access_token: result.accessToken,
          refresh_token: result.refreshToken,
          account: result.account,
        })
        return true
      }

      case "refresh": {
        const refreshToken = typeof req.body?.refresh_token === "string" ? req.body.refresh_token : null
        if (!refreshToken) {
          res.status(400).json({ error: "refresh_token is required" })
          return true
        }

        const rotationResult = await rotateRefreshToken(deps.sql, refreshToken as string, {
          ipAddress: ipAddress ?? undefined,
          userAgent: userAgent ?? undefined,
        })

        if (rotationResult.replayDetected) {
          res.status(401).json({ error: "Session compromised — all sessions revoked" })
          return true
        }

        if (!rotationResult.session) {
          res.status(401).json({ error: "Invalid or expired refresh token" })
          return true
        }

        const newSession = rotationResult.session
        const keys = await getSigningKeys(deps)

        // Load account for token payload
        const [account] = await deps.sql<{ id: string; email: string; entity_type: string }[]>`
          SELECT id, email, entity_type FROM os_accounts WHERE id = ${newSession.account_id}
        `
        if (!account) {
          res.status(401).json({ error: "Account not found" })
          return true
        }

        // Load memberships
        const memberships = await getAccountMemberships(deps.sql, account.id)
        const membershipMap: OsAccessTokenPayload['memberships'] = {}
        for (const m of memberships) {
          membershipMap[m.product] = {
            roles: m.roles,
            entitlements: m.entitlements,
            ...(m.org_id ? { org_id: m.org_id } : {}),
          }
        }

        const audience = newSession.audience[0] || "life"
        const accessToken = await signAccessToken({
          privateKey: keys.privateKey,
          kid: keys.kid,
          accountId: account.id,
          email: account.email,
          entityType: account.entity_type as any,
          audience,
          memberships: membershipMap,
        })

        await writeAudit(deps.sql, {
          account_id: account.id,
          event_type: AUDIT_EVENTS.TOKEN_REFRESH,
          ip_address: ipAddress ?? undefined,
        })

        res.json({
          ok: true,
          access_token: accessToken,
          refresh_token: newSession.refresh_token,
        })
        return true
      }

      case "me": {
        const authHeader = req.headers?.authorization || ""
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
        if (!token) {
          res.status(401).json({ error: "Missing Authorization header" })
          return true
        }

        const keys = await getSigningKeys(deps)
        // Try all common audiences
        let payload: OsAccessTokenPayload | null = null
        for (const aud of ["life", "learn"]) {
          payload = verifyAccessToken(token, keys.publicKey, aud)
          if (payload) break
        }

        if (!payload) {
          res.status(401).json({ error: "Invalid or expired token" })
          return true
        }

        const [account] = await deps.sql<{ id: string; email: string; display_name: string | null; entity_type: string; email_verified: boolean; status: string }[]>`
          SELECT id, email, display_name, entity_type, email_verified, status
          FROM os_accounts WHERE id = ${payload.sub}
        `
        if (!account) {
          res.status(401).json({ error: "Account not found" })
          return true
        }

        res.json({
          ok: true,
          account: {
            id: account.id,
            email: account.email,
            display_name: account.display_name,
            entity_type: account.entity_type,
            email_verified: account.email_verified,
            status: account.status,
          },
          memberships: payload.memberships,
        })
        return true
      }

      case "logout": {
        const refreshToken = typeof req.body?.refresh_token === "string" ? req.body.refresh_token : null
        const all = req.body?.all === true

        if (all) {
          // Need account ID from access token
          const authHeader = req.headers?.authorization || ""
          const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
          if (!token) {
            res.status(401).json({ error: "Missing Authorization header" })
            return true
          }
          const keys = await getSigningKeys(deps)
          let payload: OsAccessTokenPayload | null = null
          for (const aud of ["life", "learn"]) {
            payload = verifyAccessToken(token, keys.publicKey, aud)
            if (payload) break
          }
          if (!payload) {
            res.status(401).json({ error: "Invalid token" })
            return true
          }
          const count = await revokeAllAccountSessions(deps.sql, payload.sub)
          await writeAudit(deps.sql, {
            account_id: payload.sub,
            event_type: AUDIT_EVENTS.LOGOUT,
            ip_address: ipAddress ?? undefined,
            metadata: { scope: "all_sessions", revoked_count: count },
          })
          res.json({ ok: true, revoked: count })
        } else if (refreshToken) {
          const session = await findSessionByRefreshToken(deps.sql, refreshToken as string)
          if (session) {
            await deps.sql`UPDATE os_sessions SET revoked_at = now() WHERE id = ${session.id}`
            await writeAudit(deps.sql, {
              account_id: session.account_id,
              event_type: AUDIT_EVENTS.LOGOUT,
              ip_address: ipAddress ?? undefined,
              metadata: { scope: "single_session" },
            })
          }
          res.json({ ok: true })
        } else {
          res.status(400).json({ error: "refresh_token or all:true is required" })
        }
        return true
      }
    }
  } catch (err) {
    logger.error("OS auth route error", { handler: match.handler, error: err })
    res.status(500).json({ error: "Internal server error" })
    return true
  }

  return false
}

/** Re-export for testing */
export { _resetKeyCache }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/os-auth-routes.test.ts
```

Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/os-auth/index.ts tests/os-auth-routes.test.ts
git commit -m "[OS-AUTH] Add route dispatcher with register/login/refresh/me/logout/jwks endpoints"
```

---

## Task 15: Wire into http-routes.ts

**Files:**
- Modify: `src/http-routes.ts`

- [ ] **Step 1: Add OS auth import**

At the top of `src/http-routes.ts`, add the import alongside other API imports:

```typescript
import { handleOsAuthRoute, parseOsAuthRoute } from "./os-auth/index.ts"
```

- [ ] **Step 2: Add route exemption**

In the `requiresApiAuth()` function, add the OS auth exemption alongside the existing `app-auth` exemption:

```typescript
if (pathname.startsWith("/api/os-auth/")) return false;
```

Also add JWKS:

```typescript
if (pathname === "/.well-known/jwks.json") return false;
```

- [ ] **Step 3: Add route handler**

In the main `handleHttpRequest()` function, add the OS auth handler before the app-auth block. Look for the app-auth section (around line 4360) and add before it:

```typescript
// OS Auth API — unified identity (Phase 0)
if (url.pathname.startsWith("/api/os-auth/") || url.pathname === "/.well-known/jwks.json") {
  const body = await readBody(req);
  let data: Record<string, unknown> = {};
  if (body) {
    try { data = JSON.parse(body); } catch { /* ignore */ }
  }

  const { sql } = await import("../../ellie-forest/src/index");
  const { retrieveSecret, storeSecret } = await import("../../ellie-forest/src/hollow");

  const mockReq = {
    body: data,
    headers: {
      authorization: (req.headers["authorization"] || "") as string,
      "x-forwarded-for": (req.headers["x-forwarded-for"] || "") as string,
      "x-real-ip": (req.headers["x-real-ip"] || "") as string,
      "user-agent": (req.headers["user-agent"] || "") as string,
    },
  };
  const mockRes = {
    json: (d: unknown) => { res.writeHead(200, CORS_JSON); res.end(JSON.stringify(d)); },
    status: (code: number) => ({
      json: (d: unknown) => { res.writeHead(code, CORS_JSON); res.end(JSON.stringify(d)); },
    }),
  };

  const handled = await handleOsAuthRoute(
    mockReq, mockRes,
    url.pathname, req.method || "GET",
    { sql, retrieveSecret, storeSecret },
  );
  if (handled) return;
}
```

Note: `CORS_JSON` and `readBody` are existing helpers in http-routes.ts. Match the exact pattern used by the app-auth block. The exact variable names may differ — check the app-auth section and mirror its pattern.

- [ ] **Step 4: Run type check**

```bash
bunx tsc --noEmit 2>&1 | head -20
```

Fix any type errors.

- [ ] **Step 5: Commit**

```bash
git add src/http-routes.ts
git commit -m "[OS-AUTH] Wire OS auth routes + JWKS into relay HTTP handler"
```

---

## Task 16: Update design doc — record decision

**Files:**
- Modify: `docs/architecture/os-identity-auth.md`

- [ ] **Step 1: Update the Open Questions section**

In Section 9, update question #1 to reflect the decision:

Replace the text of question 1 with:

```markdown
1. **Where does the OS auth service live?** ~~Options: (a) new `ellie-os-auth` service, (b) endpoints in `ellie-dev` relay, (c) Supabase Auth with custom claims.~~ **Decision: (b)** — `src/os-auth/` module within ellie-dev relay. Simpler deployment; relay is the de facto OS layer. Can extract to a dedicated service later if needed.
```

- [ ] **Step 2: Commit**

```bash
git add docs/architecture/os-identity-auth.md
git commit -m "[OS-AUTH] Record architecture decision: auth module lives in ellie-dev relay"
```

---

## Summary

| Task | What | Test File |
|------|------|-----------|
| 1 | Install argon2 | — |
| 2 | os_accounts + os_auth_methods migration | — |
| 3 | os_sessions migration | — |
| 4 | os_product_memberships + consents + audit migration | — |
| 5 | Type definitions (schema.ts) | — |
| 6 | Password hashing (argon2id) | os-auth-passwords.test.ts |
| 7 | Audit log module | os-auth-audit.test.ts |
| 8 | RS256 key management | os-auth-keys.test.ts |
| 9 | Token issuance + verification | os-auth-tokens.test.ts |
| 10 | Session management + rotation detection | os-auth-sessions.test.ts |
| 11 | Registration endpoint | os-auth-registration.test.ts |
| 12 | Login endpoint | os-auth-login.test.ts |
| 13 | Product membership helpers | — |
| 14 | Route dispatcher + JWKS | os-auth-routes.test.ts |
| 15 | Wire into http-routes.ts | — |
| 16 | Update design doc | — |

After all 16 tasks, the OS auth Phase 0 foundation is complete: accounts, sessions, RS256 JWTs, token rotation, audit logging, and all endpoints wired into the relay.
