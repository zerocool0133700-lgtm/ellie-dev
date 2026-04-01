/**
 * Capture Queue API — ELLIE-769
 * CRUD operations + batch processing for the River capture queue.
 * Pure functions with injected SQL dependency for testability.
 */

// Types
export type CaptureType = "manual" | "tag" | "proactive" | "replay" | "braindump" | "template";
export type CaptureContentType = "workflow" | "decision" | "process" | "policy" | "integration" | "reference";
export type CaptureStatus = "queued" | "refined" | "approved" | "written" | "dismissed";
export type Channel = "telegram" | "ellie-chat" | "google-chat" | "voice";

export interface CaptureItem {
  id: string;
  source_message_id: string | null;
  channel: Channel;
  raw_content: string;
  refined_content: string | null;
  suggested_path: string | null;
  suggested_section: string | null;
  capture_type: CaptureType;
  content_type: CaptureContentType;
  status: CaptureStatus;
  confidence: number | null;
  created_at: string;
  updated_at: string;
  processed_at: string | null;
}

export interface AddCaptureInput {
  channel: Channel;
  raw_content: string;
  refined_content?: string;
  suggested_path?: string;
  suggested_section?: string;
  capture_type?: CaptureType;
  content_type?: CaptureContentType;
  confidence?: number;
  source_message_id?: string;
}

export interface UpdateCaptureInput {
  refined_content?: string;
  suggested_path?: string;
  suggested_section?: string;
  content_type?: CaptureContentType;
  status?: CaptureStatus;
}

export interface QueueFilters {
  status?: CaptureStatus;
  channel?: Channel;
  content_type?: CaptureContentType;
  from_date?: string;
  to_date?: string;
  limit?: number;
  offset?: number;
}

export interface CaptureStats {
  total: number;
  by_status: Record<string, number>;
  by_type: Record<string, number>;
  by_channel: Record<string, number>;
  recent_activity: { date: string; count: number }[];
}

// Validation
const VALID_CHANNELS: Channel[] = ["telegram", "ellie-chat", "google-chat", "voice"];
const VALID_CAPTURE_TYPES: CaptureType[] = ["manual", "tag", "proactive", "replay", "braindump", "template"];
const VALID_CONTENT_TYPES: CaptureContentType[] = ["workflow", "decision", "process", "policy", "integration", "reference"];
const VALID_STATUSES: CaptureStatus[] = ["queued", "refined", "approved", "written", "dismissed"];

export function validateAddInput(input: any): { valid: boolean; error?: string } {
  if (!input || typeof input !== "object") return { valid: false, error: "Request body required" };
  if (!input.channel || !VALID_CHANNELS.includes(input.channel)) {
    return { valid: false, error: `Invalid channel. Must be one of: ${VALID_CHANNELS.join(", ")}` };
  }
  if (!input.raw_content || typeof input.raw_content !== "string" || input.raw_content.trim() === "") {
    return { valid: false, error: "raw_content is required and must be non-empty" };
  }
  if (input.capture_type && !VALID_CAPTURE_TYPES.includes(input.capture_type)) {
    return { valid: false, error: `Invalid capture_type. Must be one of: ${VALID_CAPTURE_TYPES.join(", ")}` };
  }
  if (input.content_type && !VALID_CONTENT_TYPES.includes(input.content_type)) {
    return { valid: false, error: `Invalid content_type. Must be one of: ${VALID_CONTENT_TYPES.join(", ")}` };
  }
  if (input.confidence !== undefined) {
    const c = Number(input.confidence);
    if (isNaN(c) || c < 0 || c > 1) {
      return { valid: false, error: "confidence must be between 0 and 1" };
    }
  }
  return { valid: true };
}

export function validateUpdateInput(input: any): { valid: boolean; error?: string } {
  if (!input || typeof input !== "object") return { valid: false, error: "Request body required" };
  const hasField = input.refined_content !== undefined || input.suggested_path !== undefined ||
    input.suggested_section !== undefined || input.content_type !== undefined || input.status !== undefined;
  if (!hasField) return { valid: false, error: "At least one field to update is required" };
  if (input.content_type && !VALID_CONTENT_TYPES.includes(input.content_type)) {
    return { valid: false, error: `Invalid content_type. Must be one of: ${VALID_CONTENT_TYPES.join(", ")}` };
  }
  if (input.status && !VALID_STATUSES.includes(input.status)) {
    return { valid: false, error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` };
  }
  return { valid: true };
}

function isValidUUID(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

// Database operations — all take sql as first arg for testability

export async function addCapture(sql: any, input: AddCaptureInput): Promise<CaptureItem> {
  const rows = await sql`
    INSERT INTO capture_queue (
      channel, raw_content, refined_content, suggested_path, suggested_section,
      capture_type, content_type, confidence, source_message_id
    ) VALUES (
      ${input.channel},
      ${input.raw_content},
      ${input.refined_content ?? null},
      ${input.suggested_path ?? null},
      ${input.suggested_section ?? null},
      ${input.capture_type ?? "manual"},
      ${input.content_type ?? "reference"},
      ${input.confidence ?? null},
      ${input.source_message_id ?? null}
    )
    RETURNING *
  `;
  return rows[0];
}

export async function listQueue(sql: any, filters: QueueFilters = {}): Promise<{ items: CaptureItem[]; total: number }> {
  const rawLimit = Number(filters.limit);
  const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50, 200);
  const offset = filters.offset ?? 0;
  const status = filters.status ?? null;
  const channel = filters.channel ?? null;
  const contentType = filters.content_type ?? null;
  const fromDate = filters.from_date ?? null;
  const toDate = filters.to_date ?? null;

  const countRows = await sql`
    SELECT COUNT(*)::int as total FROM capture_queue
    WHERE (${status}::text IS NULL OR status::text = ${status})
    AND (${channel}::text IS NULL OR channel = ${channel})
    AND (${contentType}::text IS NULL OR content_type::text = ${contentType})
    AND (${fromDate}::timestamptz IS NULL OR created_at >= ${fromDate}::timestamptz)
    AND (${toDate}::timestamptz IS NULL OR created_at <= ${toDate}::timestamptz)
  `;
  const items = await sql`
    SELECT * FROM capture_queue
    WHERE (${status}::text IS NULL OR status::text = ${status})
    AND (${channel}::text IS NULL OR channel = ${channel})
    AND (${contentType}::text IS NULL OR content_type::text = ${contentType})
    AND (${fromDate}::timestamptz IS NULL OR created_at >= ${fromDate}::timestamptz)
    AND (${toDate}::timestamptz IS NULL OR created_at <= ${toDate}::timestamptz)
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  return { items, total: countRows[0].total };
}

export async function getCapture(sql: any, id: string): Promise<CaptureItem | null> {
  if (!isValidUUID(id)) return null;
  const rows = await sql`SELECT * FROM capture_queue WHERE id = ${id}`;
  return rows[0] ?? null;
}

export async function updateCapture(sql: any, id: string, input: UpdateCaptureInput): Promise<CaptureItem | null> {
  if (!isValidUUID(id)) return null;

  const hasField = input.refined_content !== undefined || input.suggested_path !== undefined ||
    input.suggested_section !== undefined || input.content_type !== undefined || input.status !== undefined;
  if (!hasField) return null;

  const rows = await sql`
    UPDATE capture_queue SET
      refined_content = COALESCE(${input.refined_content ?? null}, refined_content),
      suggested_path = COALESCE(${input.suggested_path ?? null}, suggested_path),
      suggested_section = COALESCE(${input.suggested_section ?? null}, suggested_section),
      content_type = COALESCE(${input.content_type ?? null}::capture_content_type, content_type),
      status = COALESCE(${input.status ?? null}::capture_status, status)
    WHERE id = ${id}
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function approveCapture(sql: any, id: string): Promise<CaptureItem | null> {
  if (!isValidUUID(id)) return null;
  const rows = await sql`
    UPDATE capture_queue
    SET status = 'approved', processed_at = NOW()
    WHERE id = ${id} AND status IN ('queued', 'refined')
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function dismissCapture(sql: any, id: string): Promise<CaptureItem | null> {
  if (!isValidUUID(id)) return null;
  const rows = await sql`
    UPDATE capture_queue
    SET status = 'dismissed', processed_at = NOW()
    WHERE id = ${id} AND status IN ('queued', 'refined')
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function getStats(sql: any): Promise<CaptureStats> {
  const [totalRows, statusRows, typeRows, channelRows, activityRows] = await Promise.all([
    sql`SELECT COUNT(*)::int as total FROM capture_queue`,
    sql`SELECT status, COUNT(*)::int as count FROM capture_queue GROUP BY status`,
    sql`SELECT content_type, COUNT(*)::int as count FROM capture_queue GROUP BY content_type`,
    sql`SELECT channel, COUNT(*)::int as count FROM capture_queue GROUP BY channel`,
    sql`SELECT DATE(created_at) as date, COUNT(*)::int as count FROM capture_queue WHERE created_at >= NOW() - INTERVAL '7 days' GROUP BY DATE(created_at) ORDER BY date DESC`,
  ]);

  const by_status: Record<string, number> = {};
  for (const r of statusRows) by_status[r.status] = r.count;

  const by_type: Record<string, number> = {};
  for (const r of typeRows) by_type[r.content_type] = r.count;

  const by_channel: Record<string, number> = {};
  for (const r of channelRows) by_channel[r.channel] = r.count;

  return {
    total: totalRows[0].total,
    by_status,
    by_type,
    by_channel,
    recent_activity: activityRows.map((r: any) => ({ date: r.date, count: r.count })),
  };
}
