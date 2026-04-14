/**
 * OS Auth — Session Management
 *
 * Manages refresh token sessions with token family rotation detection.
 * When a refresh token is reused after rotation, the entire family is revoked
 * (indicates token theft — see design doc §4.2).
 */

import { randomUUID } from "crypto"
import type { Sql, TransactionSql } from "postgres"
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

/** Create a new session row in the database. Accepts a plain connection or a transaction handle. */
export async function createSession(
  sql: Sql | TransactionSql,
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
  sql: Sql | TransactionSql,
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
  // Entire lookup + revoke + reissue runs inside one transaction with FOR UPDATE
  // to prevent concurrent refresh of the same token (TOCTOU race).
  return sql.begin(async (tx) => {
    const [oldSession] = await tx<OsSession[]>`
      SELECT * FROM os_sessions
      WHERE refresh_token = ${oldRefreshToken}
      FOR UPDATE
    `

    if (!oldSession) {
      return { session: null, replayDetected: false }
    }

    // Replay detection: if this token was already revoked, someone stole it
    if (isSessionRevoked(oldSession)) {
      logger.warn("Refresh token replay detected — revoking entire family", {
        token_family: oldSession.token_family,
        account_id: oldSession.account_id,
      })
      await revokeFamilySessions(tx, oldSession.token_family)
      await writeAudit(tx, {
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

    // Atomically revoke the old token and issue a new one in the same family.
    const newRefreshToken = generateRefreshToken()
    await tx`
      UPDATE os_sessions SET revoked_at = now() WHERE id = ${oldSession.id}
    `

    const newSession = await createSession(tx, {
      accountId: oldSession.account_id,
      refreshToken: newRefreshToken,
      audience: oldSession.audience,
      tokenFamily: oldSession.token_family,
      ipAddress: opts?.ipAddress,
      userAgent: opts?.userAgent,
    })

    return { session: newSession, replayDetected: false as const }
  })
}

/** Revoke all sessions in a token family. */
export async function revokeFamilySessions(sql: Sql | TransactionSql, tokenFamily: string): Promise<number> {
  const result = await sql`
    UPDATE os_sessions SET revoked_at = now()
    WHERE token_family = ${tokenFamily} AND revoked_at IS NULL
  `
  return result.count
}

/** Revoke all sessions for an account (e.g., on logout-everywhere or password change). */
export async function revokeAllAccountSessions(sql: Sql | TransactionSql, accountId: string): Promise<number> {
  const result = await sql`
    UPDATE os_sessions SET revoked_at = now()
    WHERE account_id = ${accountId} AND revoked_at IS NULL
  `
  return result.count
}
