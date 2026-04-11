/**
 * Mountain River Sink — ELLIE-661
 *
 * Connects Mountain to River storage. Ingested mountain_records
 * get mapped to markdown documents with YAML frontmatter and
 * written to the River vault for long-term retrieval.
 *
 * Pattern: pure builders (testable) + effectful writer (injectable fetch).
 */

import { log } from "../logger.ts";
import type { MountainRecord } from "./records.ts";

const logger = log.child("mountain-river-sink");

// ── Types ────────────────────────────────────────────────────

/**
 * A pre-entity-extraction document ready to be written to River.
 */
export interface RawDocument {
  /** Relative path within the River vault (e.g. "mountain/relay/msg-abc.md") */
  path: string;
  /** Markdown content body */
  content: string;
  /** YAML frontmatter metadata */
  frontmatter: Record<string, unknown>;
  /** Source mountain_records ID */
  mountainRecordId: string;
  /** Source external ID */
  externalId: string;
  /** Record version at time of mapping */
  version: number;
}

export interface RiverSinkResult {
  /** Number of documents successfully written */
  written: number;
  /** Number of documents skipped (dedup) */
  skipped: number;
  /** Errors encountered during flush */
  errors: Array<{ path: string; error: string }>;
  /** Duration of the flush operation in ms */
  durationMs: number;
}

export interface RiverSinkConfig {
  /** Base URL for the Bridge River API. Default: http://localhost:3001 */
  baseUrl?: string;
  /** Injectable fetch for testing */
  fetchFn?: typeof fetch;
}

// ── Pure Mapping ─────────────────────────────────────────────

/**
 * Build a safe filesystem path from a mountain record.
 * Format: mountain/{source_system}/{record_type}/{YYYY-MM-DD}/{id-prefix}.md
 */
export function buildDocumentPath(record: MountainRecord): string {
  const date = record.source_timestamp
    ? new Date(record.source_timestamp).toISOString().slice(0, 10)
    : new Date(record.created_at).toISOString().slice(0, 10);

  const idSlug = sanitizePathSegment(record.external_id).slice(0, 80);
  const source = sanitizePathSegment(record.source_system);
  const type = sanitizePathSegment(record.record_type);

  return `mountain/${source}/${type}/${date}/${idSlug}.md`;
}

/**
 * Sanitize a string for use as a path segment.
 */
export function sanitizePathSegment(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9_\-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

/**
 * Build YAML frontmatter for a River document from a mountain record.
 */
export function buildFrontmatter(record: MountainRecord): Record<string, unknown> {
  return {
    mountain_record_id: record.id,
    source_system: record.source_system,
    external_id: record.external_id,
    record_type: record.record_type,
    version: record.version,
    status: record.status,
    source_timestamp: record.source_timestamp
      ? new Date(record.source_timestamp).toISOString()
      : null,
    harvest_job_id: record.harvest_job_id,
    created_at: new Date(record.created_at).toISOString(),
    updated_at: new Date(record.updated_at).toISOString(),
  };
}

/**
 * Build the markdown content body from a mountain record's payload.
 */
export function buildDocumentContent(record: MountainRecord): string {
  const payload = record.payload ?? {};
  const lines: string[] = [];

  // Title
  const title = record.summary || payload.content || record.external_id;
  lines.push(`# ${String(title).slice(0, 200)}`);
  lines.push("");

  // Content section
  if (payload.content) {
    lines.push("## Content");
    lines.push("");
    lines.push(String(payload.content));
    lines.push("");
  }

  // Metadata section
  const metaKeys = Object.keys(payload).filter(
    (k) => k !== "content" && k !== "role",
  );
  if (metaKeys.length > 0) {
    lines.push("## Metadata");
    lines.push("");
    for (const key of metaKeys) {
      const val = payload[key];
      if (val !== null && val !== undefined) {
        lines.push(
          `- **${key}**: ${typeof val === "object" ? JSON.stringify(val) : String(val)}`,
        );
      }
    }
    lines.push("");
  }

  // Context
  if (payload.role) {
    lines.push(`> Role: ${payload.role}`);
    lines.push("");
  }

  return lines.join("\n").trim();
}

/**
 * Map a MountainRecord to a RawDocument.
 * Pure function — no side effects.
 */
export function mapRecordToDocument(record: MountainRecord): RawDocument {
  return {
    path: buildDocumentPath(record),
    content: buildDocumentContent(record),
    frontmatter: buildFrontmatter(record),
    mountainRecordId: record.id,
    externalId: record.external_id,
    version: record.version,
  };
}

// ── River Sink ───────────────────────────────────────────────

/**
 * RiverSink — batch writer from mountain_records to River vault.
 *
 * Queues records, deduplicates by external_id + version, and
 * flushes to the River vault via the Bridge River API.
 */
export class RiverSink {
  private queue: RawDocument[] = [];
  private processedVersions = new Map<string, number>();
  private baseUrl: string;
  private fetchFn: typeof fetch;

  constructor(config: RiverSinkConfig = {}) {
    this.baseUrl = config.baseUrl ?? "http://localhost:3001";
    this.fetchFn = config.fetchFn ?? fetch;
  }

  /**
   * Enqueue a mountain record for writing to River.
   * Returns the RawDocument if queued, null if skipped by dedup.
   */
  enqueue(record: MountainRecord): RawDocument | null {
    const dedupKey = `${record.source_system}:${record.external_id}`;
    const lastVersion = this.processedVersions.get(dedupKey);

    if (lastVersion !== undefined && lastVersion >= record.version) {
      logger.debug("River sink: dedup skip", {
        externalId: record.external_id,
        currentVersion: record.version,
        lastProcessedVersion: lastVersion,
      });
      return null;
    }

    const doc = mapRecordToDocument(record);
    this.queue.push(doc);
    return doc;
  }

  /**
   * Flush all queued documents to River.
   * Uses the Bridge River API (create or update).
   */
  async flush(): Promise<RiverSinkResult> {
    const start = Date.now();
    const result: RiverSinkResult = {
      written: 0,
      skipped: 0,
      errors: [],
      durationMs: 0,
    };

    if (this.queue.length === 0) {
      result.durationMs = Date.now() - start;
      return result;
    }

    const batch = [...this.queue];
    this.queue = [];

    for (const doc of batch) {
      try {
        const success = await this.writeDocument(doc);
        if (success) {
          result.written++;
          // Track processed version for dedup
          const dedupKey = `${doc.frontmatter.source_system}:${doc.externalId}`;
          this.processedVersions.set(dedupKey, doc.version);
        } else {
          result.skipped++;
        }
      } catch (err) {
        result.errors.push({
          path: doc.path,
          error: err instanceof Error ? err.message : String(err),
        });
        logger.error("River sink: write failed", {
          path: doc.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    result.durationMs = Date.now() - start;

    logger.info("River sink: flush complete", {
      written: result.written,
      skipped: result.skipped,
      errors: result.errors.length,
      durationMs: result.durationMs,
    });

    return result;
  }

  /** Get the current queue size. */
  get queueSize(): number {
    return this.queue.length;
  }

  /** Get number of tracked versions for dedup. */
  get dedupCacheSize(): number {
    return this.processedVersions.size;
  }

  /** Clear the dedup cache (e.g. on restart). */
  clearDedupCache(): void {
    this.processedVersions.clear();
  }

  /** Clear the queue without flushing. */
  clearQueue(): void {
    this.queue = [];
  }

  private async writeDocument(doc: RawDocument): Promise<boolean> {
    // Build markdown with frontmatter
    const frontmatterYaml = Object.entries(doc.frontmatter)
      .map(([k, v]) => `${k}: ${v === null ? "null" : JSON.stringify(v)}`)
      .join("\n");

    const fullContent = `---\n${frontmatterYaml}\n---\n\n${doc.content}`;

    // Try create first, fall back to update if exists
    const resp = await this.fetchFn(
      `${this.baseUrl}/api/bridge/river/write`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-bridge-key": process.env.BRIDGE_KEY || "" },
        body: JSON.stringify({
          path: doc.path,
          content: fullContent,
          operation: "update",
        }),
      },
    );

    if (!resp.ok) {
      // If update fails with 404, try create
      if (resp.status === 404) {
        const createResp = await this.fetchFn(
          `${this.baseUrl}/api/bridge/river/write`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-bridge-key": process.env.BRIDGE_KEY || "" },
            body: JSON.stringify({
              path: doc.path,
              content: fullContent,
              operation: "create",
            }),
          },
        );

        if (!createResp.ok) {
          const text = await createResp.text();
          throw new Error(`River create failed (${createResp.status}): ${text}`);
        }
        return true;
      }

      const text = await resp.text();
      throw new Error(`River update failed (${resp.status}): ${text}`);
    }

    return true;
  }
}

// ── Testing Helpers ──────────────────────────────────────────

/** Create a mock MountainRecord for testing. */
export function _makeMockRecord(
  overrides: Partial<MountainRecord> = {},
): MountainRecord {
  return {
    id: crypto.randomUUID(),
    record_type: "message",
    source_system: "relay",
    external_id: `relay:telegram:${crypto.randomUUID()}`,
    payload: { content: "Test message", channel: "telegram", role: "user" },
    summary: "Test message",
    status: "active",
    harvest_job_id: null,
    source_timestamp: new Date("2026-03-10T12:00:00Z"),
    supersedes_id: null,
    version: 1,
    created_at: new Date("2026-03-10T12:00:00Z"),
    updated_at: new Date("2026-03-10T12:00:00Z"),
    ...overrides,
  };
}
