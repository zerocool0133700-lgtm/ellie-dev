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
