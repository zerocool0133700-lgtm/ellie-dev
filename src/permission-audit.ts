/**
 * Permission Audit Logging — ELLIE-798
 * Tracks permission checks and changes for governance and debugging.
 * Pure functions with injected SQL for testability.
 */

// Types

export type AuditEventType = "check" | "change" | "role_assign" | "role_revoke";

export interface AuditEntry {
  event_type: AuditEventType;
  entity_id: string;
  entity_name?: string;
  resource?: string;
  action?: string;
  scope?: string;
  result?: string;
  changed_by?: string;
  old_value?: string;
  new_value?: string;
  metadata?: Record<string, any>;
}

export interface AuditLogRow extends AuditEntry {
  id: string;
  created_at: string;
}

export interface AuditQueryFilters {
  entity_id?: string;
  event_type?: AuditEventType;
  resource?: string;
  result?: string;
  from_date?: string;
  to_date?: string;
  limit?: number;
  offset?: number;
}

// In-memory batch buffer for high-volume check logs

const checkBuffer: AuditEntry[] = [];
const BUFFER_SIZE = 50;
const FLUSH_INTERVAL_MS = 10_000;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushCallback: ((entries: AuditEntry[]) => Promise<void>) | null = null;

export function setFlushCallback(cb: (entries: AuditEntry[]) => Promise<void>): void {
  flushCallback = cb;
}

export async function flushBuffer(): Promise<number> {
  if (checkBuffer.length === 0) return 0;
  const entries = checkBuffer.splice(0, checkBuffer.length);
  if (flushCallback) {
    try {
      await flushCallback(entries);
    } catch {
      // Re-add on failure (drop oldest if too many)
      checkBuffer.push(...entries.slice(-BUFFER_SIZE));
    }
  }
  return entries.length;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await flushBuffer();
  }, FLUSH_INTERVAL_MS);
}

// Log a permission check (buffered)

export function logCheck(
  entityId: string,
  resource: string,
  action: string,
  result: "allow" | "deny",
  scope?: string,
  entityName?: string,
): void {
  checkBuffer.push({
    event_type: "check",
    entity_id: entityId,
    entity_name: entityName,
    resource,
    action,
    scope,
    result,
  });
  if (checkBuffer.length >= BUFFER_SIZE) {
    flushBuffer();
  } else {
    scheduleFlush();
  }
}

// Log a permission change (immediate write)

export async function logChange(
  sql: any,
  entry: AuditEntry,
): Promise<void> {
  await sql`
    INSERT INTO permission_audit_log (
      event_type, entity_id, entity_name, resource, action, scope,
      result, changed_by, old_value, new_value, metadata
    ) VALUES (
      ${entry.event_type},
      ${entry.entity_id},
      ${entry.entity_name ?? null},
      ${entry.resource ?? null},
      ${entry.action ?? null},
      ${entry.scope ?? null},
      ${entry.result ?? null},
      ${entry.changed_by ?? null},
      ${entry.old_value ?? null},
      ${entry.new_value ?? null},
      ${JSON.stringify(entry.metadata ?? {})}
    )
  `;
}

// Batch write buffered entries to DB

export async function writeBatch(sql: any, entries: AuditEntry[]): Promise<number> {
  let written = 0;
  for (const entry of entries) {
    try {
      await logChange(sql, entry);
      written++;
    } catch {
      // Skip individual failures
    }
  }
  return written;
}

// Convenience loggers for specific events

export async function logRoleAssign(
  sql: any,
  entityId: string,
  roleName: string,
  changedBy?: string,
): Promise<void> {
  await logChange(sql, {
    event_type: "role_assign",
    entity_id: entityId,
    new_value: roleName,
    changed_by: changedBy,
  });
}

export async function logRoleRevoke(
  sql: any,
  entityId: string,
  roleName: string,
  changedBy?: string,
): Promise<void> {
  await logChange(sql, {
    event_type: "role_revoke",
    entity_id: entityId,
    old_value: roleName,
    changed_by: changedBy,
  });
}

export async function logPermissionChange(
  sql: any,
  resource: string,
  action: string,
  oldValue: string,
  newValue: string,
  changedBy?: string,
): Promise<void> {
  await logChange(sql, {
    event_type: "change",
    entity_id: changedBy ?? "system",
    resource,
    action,
    old_value: oldValue,
    new_value: newValue,
    changed_by: changedBy,
  });
}

// Query audit trail

export async function queryAuditLog(
  sql: any,
  filters: AuditQueryFilters = {},
): Promise<{ entries: AuditLogRow[]; total: number }> {
  const conditions: string[] = ["1=1"];
  if (filters.entity_id) conditions.push(`entity_id = '${filters.entity_id}'`);
  if (filters.event_type) conditions.push(`event_type = '${filters.event_type}'`);
  if (filters.resource) conditions.push(`resource = '${filters.resource}'`);
  if (filters.result) conditions.push(`result = '${filters.result}'`);
  if (filters.from_date) conditions.push(`created_at >= '${filters.from_date}'`);
  if (filters.to_date) conditions.push(`created_at <= '${filters.to_date}'`);

  const where = conditions.join(" AND ");
  const limit = Math.min(filters.limit ?? 50, 200);
  const offset = filters.offset ?? 0;

  const [countRows, entries] = await Promise.all([
    sql.unsafe(`SELECT COUNT(*)::int as total FROM permission_audit_log WHERE ${where}`),
    sql.unsafe(`SELECT * FROM permission_audit_log WHERE ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`),
  ]);

  return { entries, total: countRows[0]?.total ?? 0 };
}

// Summary queries

export async function getEntityActivity(
  sql: any,
  entityId: string,
  hours: number = 24,
): Promise<{ checks: number; denials: number; changes: number }> {
  const rows = await sql`
    SELECT
      COUNT(*) FILTER (WHERE event_type = 'check')::int as checks,
      COUNT(*) FILTER (WHERE event_type = 'check' AND result = 'deny')::int as denials,
      COUNT(*) FILTER (WHERE event_type IN ('change', 'role_assign', 'role_revoke'))::int as changes
    FROM permission_audit_log
    WHERE entity_id = ${entityId}
    AND created_at >= NOW() - ${hours + ' hours'}::interval
  `;
  return rows[0] ?? { checks: 0, denials: 0, changes: 0 };
}

export async function getResourceAccess(
  sql: any,
  resource: string,
  hours: number = 24,
): Promise<{ entity_id: string; entity_name: string; action: string; count: number }[]> {
  return sql`
    SELECT entity_id, entity_name, action, COUNT(*)::int as count
    FROM permission_audit_log
    WHERE resource = ${resource}
    AND event_type = 'check'
    AND created_at >= NOW() - ${hours + ' hours'}::interval
    GROUP BY entity_id, entity_name, action
    ORDER BY count DESC
  `;
}

// For testing
export function _getBufferSize(): number {
  return checkBuffer.length;
}

export function _clearBuffer(): void {
  checkBuffer.length = 0;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushCallback = null;
}
