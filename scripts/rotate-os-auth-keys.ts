#!/usr/bin/env bun
/**
 * OS Auth — Key Rotation Script (ELLIE-1262)
 *
 * Rotates the RS256 signing keys used by OS auth.
 * After rotation, new tokens are signed with the new key.
 * Old keys remain valid during a grace period (default 24h).
 *
 * Usage:
 *   bun scripts/rotate-os-auth-keys.ts                  # rotate with 24h grace
 *   bun scripts/rotate-os-auth-keys.ts --grace-hours 48 # rotate with 48h grace
 *   bun scripts/rotate-os-auth-keys.ts --dry-run        # show current keys without rotating
 *
 * Procedure:
 *   1. Run this script — it generates a new RSA-2048 key pair
 *   2. The previous key is marked to expire after the grace period
 *   3. New tokens are immediately signed with the new key
 *   4. Existing tokens signed with the old key remain valid until they
 *      naturally expire (15min access, 30d refresh) or the grace period ends
 *   5. The JWKS endpoint (/.well-known/jwks.json) serves both keys during grace
 *   6. After the grace period, the old key falls out of the JWKS response
 *
 * When to rotate:
 *   - Routine: every 90 days as a hygiene measure
 *   - Emergency: immediately if a key is suspected compromised
 *     (use --grace-hours 0 to invalidate old keys immediately)
 */

import { rotateSigningKeys, getSigningKeys, _getKeyStore } from "../src/os-auth/keys"
import { log } from "../src/logger"

const logger = log.child("key-rotation")

// ── Parse Args ────────────────────────────────────────────────

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const graceIdx = args.indexOf("--grace-hours")
const graceHours = graceIdx >= 0 ? Number(args[graceIdx + 1]) : 24

if (isNaN(graceHours) || graceHours < 0) {
  console.error("Invalid --grace-hours value. Must be a non-negative number.")
  process.exit(1)
}

const gracePeriodMs = graceHours * 60 * 60 * 1000

// ── Hollow Vault Access ───────────────────────────────────────

// The key store lives in the Hollow vault. We need the same
// retrieve/store functions the relay uses.
const HOLLOW_URL = process.env.HOLLOW_URL || "http://localhost:3001"

async function retrieveSecret(keychainId: string, key: string): Promise<string | null> {
  try {
    const res = await fetch(`${HOLLOW_URL}/api/hollow/retrieve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keychain_id: keychainId, key }),
    })
    if (!res.ok) return null
    const data = await res.json() as { value?: string }
    return data.value ?? null
  } catch {
    return null
  }
}

async function storeSecret(keychainId: string, key: string, value: string): Promise<void> {
  const res = await fetch(`${HOLLOW_URL}/api/hollow/store`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keychain_id: keychainId, key, value }),
  })
  if (!res.ok) throw new Error(`Failed to store secret: ${res.status}`)
}

const deps = { retrieveSecret, storeSecret }

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log("OS Auth Key Rotation")
  console.log("====================\n")

  // Load current keys
  const current = await getSigningKeys(deps)
  const store = _getKeyStore()

  console.log(`Current signing key: ${current.kid}`)
  console.log(`Total keys in store: ${store.length}`)
  for (const k of store) {
    const status = k.expiresAt
      ? (k.expiresAt > Date.now() ? `grace period until ${new Date(k.expiresAt).toISOString()}` : "expired")
      : "active"
    console.log(`  - ${k.kid}: ${status}`)
  }

  if (dryRun) {
    console.log("\n[dry-run] No changes made.")
    return
  }

  console.log(`\nRotating keys with ${graceHours}h grace period...`)
  const newKid = await rotateSigningKeys(deps, gracePeriodMs)

  const updatedStore = _getKeyStore()
  console.log(`\nNew signing key: ${newKid}`)
  console.log(`Total keys in store: ${updatedStore.length}`)
  for (const k of updatedStore) {
    const status = k.expiresAt
      ? `grace period until ${new Date(k.expiresAt).toISOString()}`
      : "active (current)"
    console.log(`  - ${k.kid}: ${status}`)
  }

  console.log("\nRotation complete. New tokens will be signed with the new key.")
  if (graceHours > 0) {
    console.log(`Old key remains valid for ${graceHours} hours.`)
  } else {
    console.log("WARNING: Grace period is 0 — old tokens will fail verification immediately.")
  }
}

main().catch(err => {
  logger.error("Key rotation failed", { error: err })
  console.error("Key rotation failed:", err)
  process.exit(1)
})
