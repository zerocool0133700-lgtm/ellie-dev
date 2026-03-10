/**
 * Mountain Records — ELLIE-663
 *
 * Repository for the mountain_records table. Handles CRUD operations,
 * upsert (for re-harvesting), and queries by type/source/status.
 */

import { sql } from "../../../ellie-forest/src/index.ts";
import { log } from "../logger.ts";

const logger = log.child("mountain-records");

// ── Types ────────────────────────────────────────────────────

export type MountainRecordStatus =
  | "pending"
  | "active"
  | "superseded"
  | "archived"
  | "error";

export interface MountainRecord {
  id: string;
  record_type: string;
  source_system: string;
  external_id: string;
  payload: Record<string, unknown>;
  summary: string | null;
  status: MountainRecordStatus;
  harvest_job_id: string | null;
  source_timestamp: Date | null;
  supersedes_id: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface InsertMountainRecord {
  record_type: string;
  source_system: string;
  external_id: string;
  payload: Record<string, unknown>;
  summary?: string;
  status?: MountainRecordStatus;
  harvest_job_id?: string;
  source_timestamp?: Date;
}

// ── Queries ──────────────────────────────────────────────────

/**
 * Insert a new record. Throws on duplicate (source_system, external_id).
 */
export async function insertRecord(
  rec: InsertMountainRecord,
): Promise<MountainRecord> {
  const [row] = await sql`
    INSERT INTO mountain_records (
      record_type, source_system, external_id, payload,
      summary, status, harvest_job_id, source_timestamp
    ) VALUES (
      ${rec.record_type}, ${rec.source_system}, ${rec.external_id},
      ${sql.json(rec.payload)}, ${rec.summary ?? null},
      ${rec.status ?? "active"}, ${rec.harvest_job_id ?? null},
      ${rec.source_timestamp ?? null}
    )
    RETURNING *
  `;
  logger.info("Record inserted", {
    id: row.id,
    record_type: rec.record_type,
    source_system: rec.source_system,
    external_id: rec.external_id,
  });
  return row as MountainRecord;
}

/**
 * Upsert a record — insert or update on (source_system, external_id) conflict.
 * Bumps version and marks the previous as superseded.
 */
export async function upsertRecord(
  rec: InsertMountainRecord,
): Promise<MountainRecord> {
  const [row] = await sql`
    INSERT INTO mountain_records (
      record_type, source_system, external_id, payload,
      summary, status, harvest_job_id, source_timestamp
    ) VALUES (
      ${rec.record_type}, ${rec.source_system}, ${rec.external_id},
      ${sql.json(rec.payload)}, ${rec.summary ?? null},
      ${rec.status ?? "active"}, ${rec.harvest_job_id ?? null},
      ${rec.source_timestamp ?? null}
    )
    ON CONFLICT (source_system, external_id) DO UPDATE SET
      payload = EXCLUDED.payload,
      summary = EXCLUDED.summary,
      status = COALESCE(EXCLUDED.status, mountain_records.status),
      harvest_job_id = EXCLUDED.harvest_job_id,
      source_timestamp = EXCLUDED.source_timestamp,
      version = mountain_records.version + 1,
      updated_at = NOW()
    RETURNING *
  `;
  logger.info("Record upserted", {
    id: row.id,
    record_type: rec.record_type,
    source_system: rec.source_system,
    external_id: rec.external_id,
    version: row.version,
  });
  return row as MountainRecord;
}

/**
 * Get a record by ID.
 */
export async function getRecord(id: string): Promise<MountainRecord | null> {
  const [row] = await sql`
    SELECT * FROM mountain_records WHERE id = ${id}
  `;
  return (row as MountainRecord) ?? null;
}

/**
 * Get a record by source system and external ID.
 */
export async function getRecordByExternalId(
  sourceSystem: string,
  externalId: string,
): Promise<MountainRecord | null> {
  const [row] = await sql`
    SELECT * FROM mountain_records
    WHERE source_system = ${sourceSystem}
      AND external_id = ${externalId}
  `;
  return (row as MountainRecord) ?? null;
}

/**
 * List records with optional filters.
 */
export async function listRecords(opts: {
  record_type?: string;
  source_system?: string;
  status?: MountainRecordStatus;
  limit?: number;
  offset?: number;
}): Promise<MountainRecord[]> {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const rows = await sql`
    SELECT * FROM mountain_records
    WHERE (${opts.record_type ?? null}::text IS NULL OR record_type = ${opts.record_type ?? null})
      AND (${opts.source_system ?? null}::text IS NULL OR source_system = ${opts.source_system ?? null})
      AND (${opts.status ?? null}::text IS NULL OR status::text = ${opts.status ?? null})
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows as MountainRecord[];
}

/**
 * Update a record's status.
 */
export async function updateRecordStatus(
  id: string,
  status: MountainRecordStatus,
): Promise<MountainRecord | null> {
  const [row] = await sql`
    UPDATE mountain_records
    SET status = ${status}::mountain_record_status
    WHERE id = ${id}
    RETURNING *
  `;
  if (row) {
    logger.info("Record status updated", { id, status });
  }
  return (row as MountainRecord) ?? null;
}

/**
 * Count records by type and source.
 */
export async function countRecords(opts?: {
  record_type?: string;
  source_system?: string;
  status?: MountainRecordStatus;
}): Promise<number> {
  const [row] = await sql`
    SELECT COUNT(*)::int AS count FROM mountain_records
    WHERE (${opts?.record_type ?? null}::text IS NULL OR record_type = ${opts?.record_type ?? null})
      AND (${opts?.source_system ?? null}::text IS NULL OR source_system = ${opts?.source_system ?? null})
      AND (${opts?.status ?? null}::text IS NULL OR status::text = ${opts?.status ?? null})
  `;
  return row.count;
}
