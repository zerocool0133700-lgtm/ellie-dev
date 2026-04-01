/**
 * Seed Dave's OS Account + Life Membership
 *
 * Creates Dave's account via the real registration flow, verifies it,
 * and seeds an owner membership for the Life product.
 *
 * Idempotent — safe to run multiple times.
 *
 * Usage:
 *   DAVE_OS_PASSWORD=secret bun run scripts/seed-dave-os-account.ts
 *
 * If DAVE_OS_PASSWORD is not set, defaults to "ellie-dev-local" for dev environments.
 */

import postgres from "postgres"
import { registerAccount, verifyAccountEmail } from "../src/os-auth/registration.ts"
import { upsertMembership } from "../src/os-auth/memberships.ts"

const DAVE_EMAIL = "dave@ellie-labs.dev"
const DAVE_DISPLAY_NAME = "Dave"
const ENTITY_TYPE = "user" as const
const DEFAULT_DEV_PASSWORD = "ellie-dev-local"

async function main() {
  const sql = postgres({
    host: "/var/run/postgresql",
    database: "ellie-forest",
    username: "ellie",
  })

  try {
    const password = process.env.DAVE_OS_PASSWORD || DEFAULT_DEV_PASSWORD
    if (!process.env.DAVE_OS_PASSWORD) {
      console.log(`  (no DAVE_OS_PASSWORD env var — using default dev password)`)
    }

    // ── Check if account already exists ──────────────────────
    const [existing] = await sql`
      SELECT id, status, email_verified FROM os_accounts WHERE email = ${DAVE_EMAIL}
    `

    let accountId: string

    if (existing) {
      console.log(`  Account already exists (id=${existing.id}, status=${existing.status})`)
      accountId = existing.id

      // Ensure verified + active even if a prior run was interrupted
      if (!existing.email_verified || existing.status !== "active") {
        await verifyAccountEmail(sql, accountId)
        console.log(`  Marked account as verified + active`)
      }
    } else {
      // ── Register via real flow ───────────────────────────────
      const result = await registerAccount(sql, {
        email: DAVE_EMAIL,
        password,
        display_name: DAVE_DISPLAY_NAME,
        entity_type: ENTITY_TYPE,
      })

      if (!result.ok || !result.account) {
        console.error(`  Registration failed: ${result.error}`)
        process.exit(1)
      }

      accountId = result.account.id
      console.log(`  Account created (id=${accountId})`)

      // ── Verify email (skip the token flow for seed) ──────────
      await verifyAccountEmail(sql, accountId)
      console.log(`  Account verified + active`)
    }

    // ── Seed Life membership ─────────────────────────────────
    const membership = await upsertMembership(sql, {
      accountId,
      product: "life",
      roles: ["owner"],
    })
    console.log(`  Life membership upserted (id=${membership.id}, roles=${membership.roles})`)

    console.log(`\n  Done. Dave can log in to OS auth and has Life owner membership.`)
  } finally {
    await sql.end()
  }
}

main().catch((err) => {
  console.error("Seed failed:", err)
  process.exit(1)
})
