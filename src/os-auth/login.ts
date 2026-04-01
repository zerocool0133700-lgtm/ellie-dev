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
