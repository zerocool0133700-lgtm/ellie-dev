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
