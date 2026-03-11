/**
 * Mountain Message Backfill — ELLIE-667
 *
 * Batch imports existing messages from Supabase into mountain_records
 * so Mountain has historical context from day one.
 *
 * Idempotent: uses upsert on (source_system, external_id) so it's
 * safe to re-run without creating duplicates.
 *
 * Pattern: injectable SupabaseFetcher + MountainWriter for testability.
 */

import { log } from "../logger.ts";
import type { MountainRecordStatus } from "./records.ts";

const logger = log.child("mountain-backfill");

// ── Types ────────────────────────────────────────────────────

/** A raw message row from the Supabase messages table. */
export interface SupabaseMessage {
  id: string;
  created_at: string;
  role: string;
  content: string;
  channel: string;
  metadata: Record<string, unknown> | null;
  conversation_id: string | null;
  user_id: string | null;
}

/** Options for the backfill operation. */
export interface BackfillOptions {
  /** Only import messages from this channel. */
  channel?: string;
  /** Only import messages after this date. */
  since?: Date;
  /** Only import messages before this date. */
  until?: Date;
  /** Page size for Supabase queries. Default: 100 */
  pageSize?: number;
  /** Maximum messages to import (0 = unlimited). Default: 0 */
  limit?: number;
  /** Callback for progress updates. */
  onProgress?: (progress: BackfillProgress) => void;
}

/** Progress update during backfill. */
export interface BackfillProgress {
  /** Messages processed so far */
  processed: number;
  /** Total messages to process (may be estimated) */
  total: number;
  /** Messages imported (new) */
  imported: number;
  /** Messages skipped (already exist) */
  skipped: number;
  /** Current page number */
  page: number;
  /** Percentage complete */
  percent: number;
}

/** Result of a backfill operation. */
export interface BackfillResult {
  /** Total messages processed */
  processed: number;
  /** Messages imported (new records created) */
  imported: number;
  /** Messages skipped (already in mountain_records) */
  skipped: number;
  /** Errors encountered */
  errors: Array<{ messageId: string; error: string }>;
  /** Duration in ms */
  durationMs: number;
  /** Number of pages fetched */
  pages: number;
}

// ── Normalization ───────────────────────────────────────────

/** Channel mapping from Supabase messages to mountain record source. */
export type BackfillChannel = "telegram" | "google-chat" | "ellie-chat" | "discord" | string;

/**
 * Normalize a Supabase message into a mountain_records-compatible payload.
 */
export function normalizeSupabaseMessage(msg: SupabaseMessage): NormalizedBackfillRecord {
  const channel = msg.channel ?? "unknown";
  const recordType = detectBackfillRecordType(msg);

  return {
    record_type: recordType,
    source_system: "relay",
    external_id: `backfill:${channel}:${msg.id}`,
    payload: {
      content: msg.content,
      role: msg.role,
      channel,
      sender: msg.user_id ?? null,
      conversation_id: msg.conversation_id ?? null,
      metadata: msg.metadata ?? {},
      backfilled: true,
    },
    summary: truncateContent(msg.content, 200),
    status: "active" as MountainRecordStatus,
    source_timestamp: new Date(msg.created_at),
  };
}

/** Detect record type from message metadata. */
export function detectBackfillRecordType(msg: SupabaseMessage): string {
  const meta = msg.metadata ?? {};
  if (meta.image_name || meta.image_mime) return "image_caption";
  if (meta.voice_transcript || meta.transcription || meta.is_voice) return "voice_transcript";
  return "message";
}

/** Truncate content for the summary field. */
function truncateContent(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen - 3) + "...";
}

/** The normalized payload shape for mountain_records. */
export interface NormalizedBackfillRecord {
  record_type: string;
  source_system: string;
  external_id: string;
  payload: {
    content: string;
    role: string;
    channel: string;
    sender: string | null;
    conversation_id: string | null;
    metadata: Record<string, unknown>;
    backfilled: boolean;
  };
  summary: string;
  status: MountainRecordStatus;
  source_timestamp: Date;
}

// ── Injectable Interfaces ───────────────────────────────────

/**
 * Fetches messages from Supabase in pages.
 * Injectable for testing without real Supabase.
 */
export type SupabaseFetcher = (opts: {
  channel?: string;
  since?: Date;
  until?: Date;
  limit: number;
  offset: number;
}) => Promise<{ data: SupabaseMessage[]; count: number }>;

/**
 * Writes a normalized record to mountain_records.
 * Injectable for testing without real DB writes.
 */
export type MountainWriter = (
  record: NormalizedBackfillRecord,
) => Promise<{ id: string; version: number }>;

// ── Backfill Runner ─────────────────────────────────────────

/**
 * Run the message backfill — reads from Supabase, normalizes,
 * and writes to mountain_records.
 */
export async function runBackfill(
  fetcher: SupabaseFetcher,
  writer: MountainWriter,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  const start = Date.now();
  const pageSize = opts.pageSize ?? 100;
  const maxMessages = opts.limit ?? 0;

  const result: BackfillResult = {
    processed: 0,
    imported: 0,
    skipped: 0,
    errors: [],
    durationMs: 0,
    pages: 0,
  };

  // Get initial count for progress
  const { count: totalEstimate } = await fetcher({
    channel: opts.channel,
    since: opts.since,
    until: opts.until,
    limit: 0,
    offset: 0,
  });

  const total = maxMessages > 0 ? Math.min(totalEstimate, maxMessages) : totalEstimate;
  let offset = 0;
  let keepGoing = true;

  logger.info("Backfill started", {
    totalEstimate,
    channel: opts.channel,
    since: opts.since?.toISOString(),
    until: opts.until?.toISOString(),
    pageSize,
    limit: maxMessages,
  });

  while (keepGoing) {
    const fetchLimit = maxMessages > 0
      ? Math.min(pageSize, maxMessages - result.processed)
      : pageSize;

    if (fetchLimit <= 0) break;

    const { data: messages } = await fetcher({
      channel: opts.channel,
      since: opts.since,
      until: opts.until,
      limit: fetchLimit,
      offset,
    });

    result.pages++;

    if (messages.length === 0) break;

    for (const msg of messages) {
      if (maxMessages > 0 && result.processed >= maxMessages) {
        keepGoing = false;
        break;
      }

      try {
        const normalized = normalizeSupabaseMessage(msg);
        const { version } = await writer(normalized);
        if (version === 1) {
          result.imported++;
        } else {
          result.skipped++;
        }
      } catch (err) {
        result.errors.push({
          messageId: msg.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      result.processed++;
    }

    offset += messages.length;

    // Report progress
    if (opts.onProgress) {
      opts.onProgress({
        processed: result.processed,
        total,
        imported: result.imported,
        skipped: result.skipped,
        page: result.pages,
        percent: total > 0 ? Math.round((result.processed / total) * 100) : 0,
      });
    }

    // Stop if we got fewer than requested (last page)
    if (messages.length < fetchLimit) break;
  }

  result.durationMs = Date.now() - start;

  logger.info("Backfill complete", {
    processed: result.processed,
    imported: result.imported,
    skipped: result.skipped,
    errors: result.errors.length,
    pages: result.pages,
    durationMs: result.durationMs,
  });

  return result;
}

// ── Testing Helpers ─────────────────────────────────────────

/** Create a mock Supabase message for testing. */
export function _makeMockSupabaseMessage(
  overrides: Partial<SupabaseMessage> = {},
): SupabaseMessage {
  return {
    id: crypto.randomUUID(),
    created_at: "2026-03-10T12:00:00Z",
    role: "user",
    content: "Test backfill message",
    channel: "telegram",
    metadata: {},
    conversation_id: null,
    user_id: "test-user",
    ...overrides,
  };
}

/** Create a mock SupabaseFetcher that returns predefined messages. */
export function _makeMockFetcher(messages: SupabaseMessage[]): SupabaseFetcher {
  return async (opts) => {
    let filtered = [...messages];

    if (opts.channel) {
      filtered = filtered.filter((m) => m.channel === opts.channel);
    }
    if (opts.since) {
      filtered = filtered.filter(
        (m) => new Date(m.created_at) >= opts.since!,
      );
    }
    if (opts.until) {
      filtered = filtered.filter(
        (m) => new Date(m.created_at) < opts.until!,
      );
    }

    const count = filtered.length;

    if (opts.limit === 0) {
      return { data: [], count };
    }

    const page = filtered.slice(opts.offset, opts.offset + opts.limit);
    return { data: page, count };
  };
}

/** Create a mock MountainWriter that tracks writes. */
export function _makeMockWriter(): {
  writer: MountainWriter;
  written: NormalizedBackfillRecord[];
  seenExternalIds: Set<string>;
} {
  const written: NormalizedBackfillRecord[] = [];
  const seenExternalIds = new Set<string>();

  const writer: MountainWriter = async (record) => {
    const isNew = !seenExternalIds.has(record.external_id);
    seenExternalIds.add(record.external_id);
    written.push(record);
    return { id: crypto.randomUUID(), version: isNew ? 1 : 2 };
  };

  return { writer, written, seenExternalIds };
}
