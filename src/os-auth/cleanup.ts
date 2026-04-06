/**
 * OS Auth — Token & Session Cleanup
 *
 * Purges expired and consumed verification tokens, and expired
 * or revoked sessions. Intended to run on a periodic schedule.
 */

import type { Sql } from "postgres"
import { log } from "../logger.ts"

const logger = log.child("os-auth-cleanup")

/**
 * Delete verification tokens that are expired or were consumed
 * more than 7 days ago.
 */
export async function purgeExpiredVerificationTokens(sql: Sql): Promise<number> {
  const rows = await sql`
    DELETE FROM os_email_verification_tokens
    WHERE expires_at < now()
       OR (consumed_at IS NOT NULL AND consumed_at < now() - interval '7 days')
    RETURNING id
  `
  logger.info("Purged expired verification tokens", { count: rows.length })
  return rows.length
}

/**
 * Delete sessions that are expired or were revoked more than
 * 7 days ago.
 */
export async function purgeExpiredSessions(sql: Sql): Promise<number> {
  const rows = await sql`
    DELETE FROM os_sessions
    WHERE expires_at < now()
       OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')
    RETURNING id
  `
  logger.info("Purged expired sessions", { count: rows.length })
  return rows.length
}

/**
 * Run all cleanup tasks and return the counts.
 */
export async function runCleanup(sql: Sql): Promise<{ tokens: number; sessions: number }> {
  const tokens = await purgeExpiredVerificationTokens(sql)
  const sessions = await purgeExpiredSessions(sql)
  return { tokens, sessions }
}
