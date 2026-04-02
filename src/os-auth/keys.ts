/**
 * OS Auth — RS256 Key Management (ELLIE-1259 / ELLIE-1262)
 *
 * Supports multiple active signing keys for zero-downtime rotation.
 * Tokens are signed with the newest key; verification accepts any
 * non-expired key. The JWKS endpoint returns all active public keys.
 *
 * Key ID (kid) format: "os-auth-{timestamp}"
 *
 * Rotation procedure:
 *   1. Call rotateSigningKeys() — generates a new key pair, marks the
 *      old key for expiry after a grace period (default 24 hours).
 *   2. New tokens are signed with the new key immediately.
 *   3. Old tokens remain valid until they expire (15 min access, 30 day refresh).
 *   4. After the grace period, the old key is removed from the JWKS response.
 */

import { generateKeyPairSync, createPublicKey } from "crypto"
import { log } from "../logger.ts"

const logger = log.child("os-auth-keys")

// ── Types ──────────────────────────────────────────────────

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

interface StoredKeyRecord {
  kid: string
  publicKey: string
  privateKey: string
  createdAt: number  // epoch ms
  expiresAt?: number // epoch ms — undefined means no expiry (active key)
}

// ── Key Generation ─────────────────────────────────────────

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

// ── Multi-Key Store ────────────────────────────────────────

let _keyStore: StoredKeyRecord[] = []

const OS_AUTH_KEYCHAIN_ID = "os-auth-signing-keys"
const DEFAULT_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000 // 24 hours

interface KeyDeps {
  retrieveSecret: (keychainId: string, key: string) => Promise<string | null>
  storeSecret?: (keychainId: string, key: string, value: string) => Promise<void>
}

/** Serialize key store to JSON for vault storage. */
function serializeKeyStore(keys: StoredKeyRecord[]): string {
  return JSON.stringify(keys)
}

/** Deserialize key store from vault JSON. */
function deserializeKeyStore(json: string): StoredKeyRecord[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Persist key store to Hollow vault. */
async function persistKeyStore(deps: KeyDeps): Promise<void> {
  if (!deps.storeSecret) return
  await deps.storeSecret(OS_AUTH_KEYCHAIN_ID, "key_store", serializeKeyStore(_keyStore))
}

/** Get all active (non-expired) keys. */
function getActiveKeys(now: number = Date.now()): StoredKeyRecord[] {
  return _keyStore.filter(k => !k.expiresAt || k.expiresAt > now)
}

/** Get the current signing key (newest active key). */
function getCurrentKey(now: number = Date.now()): StoredKeyRecord | null {
  const active = getActiveKeys(now)
  return active.length > 0 ? active[active.length - 1] : null
}

// ── Public API ─────────────────────────────────────────────

/**
 * Load or generate the signing key pair.
 * On first call: checks The Hollow for existing keys. If none, generates + stores.
 * Subsequent calls return the current (newest) signing key.
 *
 * Backwards-compatible: migrates single-key storage to multi-key format.
 */
export async function getSigningKeys(deps: KeyDeps): Promise<{ privateKey: string; publicKey: string; kid: string }> {
  if (_keyStore.length > 0) {
    const current = getCurrentKey()
    if (current) {
      return { privateKey: current.privateKey, publicKey: current.publicKey, kid: current.kid }
    }
  }

  // Try loading multi-key store from Hollow
  const storedKeyStore = await deps.retrieveSecret(OS_AUTH_KEYCHAIN_ID, "key_store")
  if (storedKeyStore) {
    _keyStore = deserializeKeyStore(storedKeyStore)
    const current = getCurrentKey()
    if (current) {
      logger.info("Loaded OS auth key store from Hollow", { keyCount: _keyStore.length, currentKid: current.kid })
      return { privateKey: current.privateKey, publicKey: current.publicKey, kid: current.kid }
    }
  }

  // Try loading legacy single-key format (backwards compat)
  // DEPRECATED: Legacy single-key format will be removed after 2026-07-01.
  // All deployments should have migrated to multi-key format by then.
  // See: scripts/rotate-os-auth-keys.ts for the rotation procedure.
  const storedPrivate = await deps.retrieveSecret(OS_AUTH_KEYCHAIN_ID, "private_key")
  const storedPublic = await deps.retrieveSecret(OS_AUTH_KEYCHAIN_ID, "public_key")
  const storedKid = await deps.retrieveSecret(OS_AUTH_KEYCHAIN_ID, "kid")

  if (storedPrivate && storedPublic && storedKid) {
    const LEGACY_DEPRECATION_DATE = new Date("2026-07-01T00:00:00Z")
    if (Date.now() >= LEGACY_DEPRECATION_DATE.getTime()) {
      // ELLIE-1263: Hard cutoff — refuse to load legacy format after sunset
      throw new Error("Legacy single-key auth format is past its deprecation date (2026-07-01). Run `bun scripts/rotate-os-auth-keys.ts` to migrate to multi-key format.")
    }
    logger.warn("DEPRECATED: Legacy single-key auth format detected. Auto-migrating to multi-key format. This fallback will be removed after 2026-07-01.", { kid: storedKid })

    // Migrate to multi-key format
    _keyStore = [{
      kid: storedKid,
      publicKey: storedPublic,
      privateKey: storedPrivate,
      createdAt: Date.now(),
    }]
    await persistKeyStore(deps)
    logger.info("Migrated single signing key to key store", { kid: storedKid })
    return { privateKey: storedPrivate, publicKey: storedPublic, kid: storedKid }
  }

  // Generate first key pair
  const { publicKey, privateKey } = await generateKeyPair()
  const kid = `os-auth-${Date.now()}`

  _keyStore = [{
    kid,
    publicKey: publicKey,
    privateKey: privateKey,
    createdAt: Date.now(),
  }]

  await persistKeyStore(deps)
  logger.info("Generated and stored initial OS auth signing key", { kid })

  return { privateKey, publicKey, kid }
}

/**
 * Get all active public keys for the JWKS endpoint.
 * Returns keys for both current and grace-period keys.
 */
export async function getAllActivePublicKeys(deps: KeyDeps): Promise<Jwk[]> {
  // Ensure keys are loaded
  await getSigningKeys(deps)
  return getActiveKeys().map(k => publicKeyToJwk(k.publicKey, k.kid))
}

/**
 * Find a public key by kid — used during token verification to
 * validate tokens signed with any active key.
 */
export function findPublicKeyByKid(kid: string): string | null {
  const key = getActiveKeys().find(k => k.kid === kid)
  return key?.publicKey ?? null
}

/**
 * Rotate signing keys. Generates a new key pair and marks the
 * current key for expiry after the grace period.
 *
 * @param gracePeriodMs - How long old keys remain valid (default 24h).
 * @returns The new key's kid.
 */
export async function rotateSigningKeys(
  deps: KeyDeps,
  gracePeriodMs: number = DEFAULT_GRACE_PERIOD_MS,
): Promise<string> {
  // Ensure current keys are loaded
  await getSigningKeys(deps)

  const now = Date.now()

  // Mark all existing non-expiring keys for expiry
  for (const key of _keyStore) {
    if (!key.expiresAt) {
      key.expiresAt = now + gracePeriodMs
    }
  }

  // Purge already-expired keys
  _keyStore = _keyStore.filter(k => !k.expiresAt || k.expiresAt > now)

  // Generate new key — append random suffix to avoid kid collision in same ms
  const { publicKey, privateKey } = await generateKeyPair()
  const kid = `os-auth-${now}-${Math.random().toString(36).slice(2, 6)}`

  _keyStore.push({
    kid,
    publicKey,
    privateKey,
    createdAt: now,
  })

  await persistKeyStore(deps)

  logger.info("Signing keys rotated", {
    newKid: kid,
    totalActiveKeys: _keyStore.length,
    gracePeriodMs,
  })

  return kid
}

/** Reset cached keys — for testing only. */
export function _resetKeyCache(): void {
  _keyStore = []
}

/** Get the raw key store — for testing only. */
export function _getKeyStore(): StoredKeyRecord[] {
  return _keyStore
}
