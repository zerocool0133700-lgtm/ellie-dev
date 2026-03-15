/**
 * Agent Audit Log — ELLIE-728
 *
 * Complete audit trail of agent actions for governance, compliance,
 * and debugging. No PII — reference IDs only.
 *
 * Database functions module — uses postgres.js via ellie-forest.
 */

import { sql } from "../../ellie-forest/src/index";

// ── Types ────────────────────────────────────────────────────

export type AuditActionType =
  | "dispatch"
  | "checkout"
  | "completion"
  | "failure"
  | "approval_requested"
  | "approval_granted"
  | "approval_denied"
  | "delegation"
  | "escalation"
  | "budget_exceeded";

export const VALID_AUDIT_ACTION_TYPES = [
  "dispatch",
  "checkout",
  "completion",
  "failure",
  "approval_requested",
  "approval_granted",
  "approval_denied",
  "delegation",
  "escalation",
  "budget_exceeded",
] as const;

export const DEFAULT_RETENTION_DAYS = 90;

export interface AuditLogEntry {
  id: string;
  created_at: Date;
  agent_id: string;
  company_id: string | null;
  action_type: AuditActionType;
  action_detail: Record<string, unknown>;
  formation_session_id: string | null;
  work_item_id: string | null;
}

export interface LogActionInput {
  agent_id: string;
  action_type: AuditActionType;
  action_detail?: Record<string, unknown>;
  company_id?: string;
  formation_session_id?: string;
  work_item_id?: string;
}

export interface AuditQueryOptions {
  agent_id?: string;
  company_id?: string;
  action_type?: AuditActionType;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export interface RetentionPolicy {
  company_id: string;
  retention_days: number;
  created_at: Date;
  updated_at: Date;
}

// ── Log Action ──────────────────────────────────────────────

/**
 * Log an agent action to the audit trail.
 * action_detail should contain reference IDs only — no PII.
 */
export async function logAction(input: LogActionInput): Promise<AuditLogEntry> {
  const [entry] = await sql<AuditLogEntry[]>`
    INSERT INTO agent_audit_log (
      agent_id, company_id, action_type, action_detail,
      formation_session_id, work_item_id
    )
    VALUES (
      ${input.agent_id}::uuid,
      ${input.company_id ?? null}::uuid,
      ${input.action_type},
      ${sql.json(input.action_detail ?? {})},
      ${input.formation_session_id ?? null}::uuid,
      ${input.work_item_id ?? null}
    )
    RETURNING *
  `;

  return entry;
}

/**
 * Log multiple actions in a single batch insert.
 */
export async function logActionBatch(inputs: LogActionInput[]): Promise<number> {
  if (inputs.length === 0) return 0;

  let count = 0;
  for (const input of inputs) {
    await logAction(input);
    count++;
  }
  return count;
}

// ── Query ───────────────────────────────────────────────────

/**
 * Query the audit log with flexible filters.
 * All filters are optional and combined with AND.
 */
export async function queryAuditLog(
  opts: AuditQueryOptions = {},
): Promise<AuditLogEntry[]> {
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;

  // Build conditions dynamically. Use the most common query patterns
  // as separate branches for clean SQL.
  if (opts.agent_id && opts.action_type && opts.from && opts.to) {
    return sql<AuditLogEntry[]>`
      SELECT * FROM agent_audit_log
      WHERE agent_id = ${opts.agent_id}::uuid
        AND action_type = ${opts.action_type}
        AND created_at >= ${opts.from.toISOString()}::timestamptz
        AND created_at <= ${opts.to.toISOString()}::timestamptz
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  if (opts.agent_id && opts.action_type) {
    return sql<AuditLogEntry[]>`
      SELECT * FROM agent_audit_log
      WHERE agent_id = ${opts.agent_id}::uuid
        AND action_type = ${opts.action_type}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  if (opts.company_id && opts.action_type) {
    return sql<AuditLogEntry[]>`
      SELECT * FROM agent_audit_log
      WHERE company_id = ${opts.company_id}::uuid
        AND action_type = ${opts.action_type}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  if (opts.agent_id) {
    return sql<AuditLogEntry[]>`
      SELECT * FROM agent_audit_log
      WHERE agent_id = ${opts.agent_id}::uuid
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  if (opts.company_id) {
    return sql<AuditLogEntry[]>`
      SELECT * FROM agent_audit_log
      WHERE company_id = ${opts.company_id}::uuid
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  if (opts.action_type) {
    return sql<AuditLogEntry[]>`
      SELECT * FROM agent_audit_log
      WHERE action_type = ${opts.action_type}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  if (opts.from && opts.to) {
    return sql<AuditLogEntry[]>`
      SELECT * FROM agent_audit_log
      WHERE created_at >= ${opts.from.toISOString()}::timestamptz
        AND created_at <= ${opts.to.toISOString()}::timestamptz
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  return sql<AuditLogEntry[]>`
    SELECT * FROM agent_audit_log
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

/**
 * Get audit entries for a specific formation session.
 */
export async function getSessionAuditLog(
  sessionId: string,
): Promise<AuditLogEntry[]> {
  return sql<AuditLogEntry[]>`
    SELECT * FROM agent_audit_log
    WHERE formation_session_id = ${sessionId}::uuid
    ORDER BY created_at ASC
  `;
}

/**
 * Count audit entries matching filters.
 */
export async function countAuditEntries(
  opts: Pick<AuditQueryOptions, "agent_id" | "company_id" | "action_type"> = {},
): Promise<number> {
  if (opts.agent_id && opts.action_type) {
    const [row] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM agent_audit_log
      WHERE agent_id = ${opts.agent_id}::uuid AND action_type = ${opts.action_type}
    `;
    return row.count;
  }

  if (opts.agent_id) {
    const [row] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM agent_audit_log
      WHERE agent_id = ${opts.agent_id}::uuid
    `;
    return row.count;
  }

  if (opts.company_id) {
    const [row] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM agent_audit_log
      WHERE company_id = ${opts.company_id}::uuid
    `;
    return row.count;
  }

  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM agent_audit_log
  `;
  return row.count;
}

// ── Retention Policy ────────────────────────────────────────

/**
 * Set the retention policy for a company (upsert).
 */
export async function setRetentionPolicy(
  companyId: string,
  retentionDays: number,
): Promise<RetentionPolicy> {
  const [policy] = await sql<RetentionPolicy[]>`
    INSERT INTO audit_retention_policies (company_id, retention_days)
    VALUES (${companyId}::uuid, ${retentionDays})
    ON CONFLICT (company_id) DO UPDATE SET
      retention_days = ${retentionDays},
      updated_at = NOW()
    RETURNING *
  `;

  return policy;
}

/**
 * Get the retention policy for a company.
 * Returns default (90 days) if no policy is set.
 */
export async function getRetentionPolicy(
  companyId: string,
): Promise<RetentionPolicy | null> {
  const [policy] = await sql<RetentionPolicy[]>`
    SELECT * FROM audit_retention_policies
    WHERE company_id = ${companyId}::uuid
  `;
  return policy ?? null;
}

/**
 * Apply retention policies: delete audit entries older than
 * the configured retention period for each company.
 * Returns the number of entries deleted.
 */
export async function applyRetentionPolicies(): Promise<number> {
  // Delete entries for companies with custom policies
  const deleted = await sql<{ id: string }[]>`
    DELETE FROM agent_audit_log
    WHERE company_id IN (
      SELECT company_id FROM audit_retention_policies
    )
    AND created_at < (
      SELECT NOW() - (p.retention_days || ' days')::interval
      FROM audit_retention_policies p
      WHERE p.company_id = agent_audit_log.company_id
    )
    RETURNING id
  `;

  // Delete entries with no company using default retention
  const defaultDeleted = await sql<{ id: string }[]>`
    DELETE FROM agent_audit_log
    WHERE company_id IS NULL
      AND created_at < NOW() - INTERVAL '${DEFAULT_RETENTION_DAYS} days'
    RETURNING id
  `;

  return deleted.length + defaultDeleted.length;
}
