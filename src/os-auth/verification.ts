/**
 * OS Auth — Email Verification Tokens
 *
 * Generates and consumes one-time email verification tokens.
 * Tokens are created on registration and consumed via
 * POST /api/os-auth/verify-email.
 */

import { randomBytes } from "crypto"
import type { Sql } from "postgres"
import { log } from "../logger.ts"

const logger = log.child("os-auth-verification")

export const VERIFICATION_TOKEN_EXPIRY_HOURS = 24

/** Generate a prefixed cryptographic token. */
export function generateVerificationToken(): string {
  return "osev_" + randomBytes(32).toString("hex")
}

/**
 * Create a verification token for an account and persist it.
 * Accepts either a top-level Sql or a transaction handle (both are
 * tagged-template callables in postgres.js).
 */
export async function createVerificationToken(
  sql: Sql,
  accountId: string,
): Promise<string> {
  const token = generateVerificationToken()
  const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_EXPIRY_HOURS * 60 * 60 * 1000)

  await sql`
    INSERT INTO os_email_verification_tokens (account_id, token, expires_at)
    VALUES (${accountId}, ${token}, ${expiresAt})
  `

  logger.info("Verification token created", { accountId })
  return token
}

/**
 * Consume a verification token — validates it, marks it used, and returns
 * the account ID so the caller can activate the account.
 */
export async function consumeVerificationToken(
  sql: Sql,
  token: string,
): Promise<{ ok: true; accountId: string } | { ok: false; error: string }> {
  const [row] = await sql`
    SELECT id, account_id, expires_at, consumed_at
    FROM os_email_verification_tokens
    WHERE token = ${token}
  `

  if (!row) return { ok: false, error: "Invalid verification token" }
  if (row.consumed_at) return { ok: false, error: "Token has already been used" }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, error: "Verification token has expired" }
  }

  // Mark consumed
  await sql`
    UPDATE os_email_verification_tokens
    SET consumed_at = now()
    WHERE id = ${row.id}
  `

  logger.info("Verification token consumed", { accountId: row.account_id })
  return { ok: true, accountId: row.account_id }
}
