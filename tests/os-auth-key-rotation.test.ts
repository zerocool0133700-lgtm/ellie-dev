import { describe, it, expect, beforeEach } from "bun:test"
import {
  getSigningKeys,
  rotateSigningKeys,
  getAllActivePublicKeys,
  findPublicKeyByKid,
  _resetKeyCache,
  _getKeyStore,
} from "../src/os-auth/keys"
import { signAccessToken, verifyAccessToken } from "../src/os-auth/tokens"

// In-memory vault for testing
function createTestVault() {
  const store = new Map<string, string>()
  return {
    retrieveSecret: async (_kc: string, key: string) => store.get(key) ?? null,
    storeSecret: async (_kc: string, key: string, value: string) => { store.set(key, value) },
  }
}

describe("OS Auth — Key Rotation (ELLIE-1259 / ELLIE-1262)", () => {
  beforeEach(() => {
    _resetKeyCache()
  })

  it("generates initial key on first call", async () => {
    const vault = createTestVault()
    const keys = await getSigningKeys(vault)

    expect(keys.kid).toMatch(/^os-auth-/)
    expect(keys.privateKey).toContain("BEGIN PRIVATE KEY")
    expect(keys.publicKey).toContain("BEGIN PUBLIC KEY")
    expect(_getKeyStore()).toHaveLength(1)
  })

  it("rotateSigningKeys creates a new key and marks old for expiry", async () => {
    const vault = createTestVault()
    const original = await getSigningKeys(vault)

    const newKid = await rotateSigningKeys(vault)

    expect(newKid).not.toBe(original.kid)
    expect(_getKeyStore()).toHaveLength(2)

    // New key is the current signing key
    const current = await getSigningKeys(vault)
    expect(current.kid).toBe(newKid)

    // Old key has an expiry set
    const oldKey = _getKeyStore().find(k => k.kid === original.kid)
    expect(oldKey?.expiresAt).toBeDefined()
  })

  it("JWKS endpoint returns all active keys", async () => {
    const vault = createTestVault()
    await getSigningKeys(vault)
    await rotateSigningKeys(vault)

    const jwks = await getAllActivePublicKeys(vault)
    expect(jwks).toHaveLength(2)
    expect(jwks.every(k => k.kty === "RSA")).toBe(true)
  })

  it("findPublicKeyByKid returns correct key", async () => {
    const vault = createTestVault()
    const original = await getSigningKeys(vault)
    await rotateSigningKeys(vault)

    const pubKey = findPublicKeyByKid(original.kid)
    expect(pubKey).toBe(original.publicKey)
  })

  it("tokens signed with old key verify with old public key during grace period", async () => {
    const vault = createTestVault()
    const oldKeys = await getSigningKeys(vault)

    // Sign a token with the old key
    const token = await signAccessToken({
      privateKey: oldKeys.privateKey,
      kid: oldKeys.kid,
      accountId: "acct-1",
      email: "test@example.com",
      entityType: "user",
      audience: "life",
      memberships: {},
    })

    // Rotate
    await rotateSigningKeys(vault)

    // Old key is still in grace period — verification should work
    const oldPubKey = findPublicKeyByKid(oldKeys.kid)
    expect(oldPubKey).not.toBeNull()
    const payload = verifyAccessToken(token, oldPubKey!, "life")
    expect(payload).not.toBeNull()
    expect(payload!.sub).toBe("acct-1")
  })

  it("expired keys are purged on next rotation", async () => {
    const vault = createTestVault()
    await getSigningKeys(vault)

    // Rotate with 0ms grace period (expires immediately)
    await rotateSigningKeys(vault, 1)

    // Wait for the grace period to pass
    await new Promise(r => setTimeout(r, 5))

    // Rotate again — old key should be purged
    await rotateSigningKeys(vault, 1)

    // Only the two most recent keys (one expiring, one current)
    const store = _getKeyStore()
    expect(store.length).toBeLessThanOrEqual(2)
  })

  it("persists key store to vault", async () => {
    const vault = createTestVault()
    await getSigningKeys(vault)
    const originalKid = (await getSigningKeys(vault)).kid

    // Reset cache and reload from vault
    _resetKeyCache()
    const reloaded = await getSigningKeys(vault)
    expect(reloaded.kid).toBe(originalKid)
  })

  it("migrates legacy single-key format", async () => {
    // Set up vault with legacy format
    const store = new Map<string, string>()
    const vault = {
      retrieveSecret: async (_kc: string, key: string) => store.get(key) ?? null,
      storeSecret: async (_kc: string, key: string, value: string) => { store.set(key, value) },
    }

    // Simulate legacy storage
    const { generateKeyPair } = await import("../src/os-auth/keys")
    const pair = await generateKeyPair()
    store.set("private_key", pair.privateKey)
    store.set("public_key", pair.publicKey)
    store.set("kid", "os-auth-legacy")

    const keys = await getSigningKeys(vault)
    expect(keys.kid).toBe("os-auth-legacy")

    // Should now have a key_store entry
    expect(store.has("key_store")).toBe(true)
  })
})
