/**
 * OS Auth — Audit Log
 *
 * Append-only structured event log for all auth events.
 * writeAudit() inserts to Forest DB; buildAuditEntry() is pure (for testing).
 */

import type { Sql } from "postgres"
import { log } from "../logger.ts"

const logger = log.child("os-auth-audit")

export const AUDIT_EVENTS = {
  LOGIN: "login",
  LOGOUT: "logout",
  LOGIN_FAILED: "login_failed",
  TOKEN_REFRESH: "token_refresh",
  PASSWORD_CHANGE: "password_change",
  MFA_ENROLL: "mfa_enroll",
  PERMISSION_GRANT: "permission_grant",
  PERMISSION_REVOKE: "permission_revoke",
  ACCOUNT_CREATE: "account_create",
  ACCOUNT_DELETE: "account_delete",
  TOKEN_FAMILY_REVOKED: "token_family_revoked",
  EMAIL_VERIFIED: "email_verified",
  MAGIC_LINK_SENT: "magic_link_sent",
} as const

export type AuditEventType = typeof AUDIT_EVENTS[keyof typeof AUDIT_EVENTS]

interface AuditInput {
  account_id?: string | null
  event_type: AuditEventType
  product?: string | null
  ip_address?: string | null
  user_agent?: string | null
  metadata?: Record<string, unknown>
}

interface AuditEntry {
  account_id: string | null
  event_type: string
  product: string | null
  ip_address: string | null
  user_agent: string | null
  metadata: Record<string, unknown>
}

/** Pure function — builds an audit entry without touching the DB. */
export function buildAuditEntry(input: AuditInput): AuditEntry {
  return {
    account_id: input.account_id ?? null,
    event_type: input.event_type,
    product: input.product ?? null,
    ip_address: input.ip_address ?? null,
    user_agent: input.user_agent ?? null,
    metadata: input.metadata ?? {},
  }
}

/** Write an audit entry to Forest DB. Fire-and-forget — never throws. */
export async function writeAudit(sql: Sql, input: AuditInput): Promise<void> {
  const entry = buildAuditEntry(input)
  try {
    await sql`
      INSERT INTO os_audit_log (account_id, event_type, product, ip_address, user_agent, metadata)
      VALUES (${entry.account_id}, ${entry.event_type}, ${entry.product},
              ${entry.ip_address}::inet, ${entry.user_agent}, ${JSON.stringify(entry.metadata)})
    `
  } catch (err) {
    logger.error("Failed to write audit log", { error: err, entry })
  }
}
