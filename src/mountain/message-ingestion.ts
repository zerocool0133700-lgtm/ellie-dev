/**
 * Mountain Message Ingestion — ELLIE-660
 *
 * Real-time ingestion of relay messages into mountain_records.
 * Called as a fire-and-forget hook after saveMessage().
 *
 * Also implements MountainSource for batch re-harvesting of
 * historical messages on demand.
 */

import { log } from "../logger.ts";
import { upsertRecord } from "./records.ts";
import { emitDomainEvent } from "../ums/domain-events.ts";
import type {
  MountainSource,
  SourceStatus,
  HarvestJob,
  HarvestResult,
  HarvestItem,
  HarvestError,
} from "./types.ts";

const logger = log.child("mountain-ingestion");

// ── Types ────────────────────────────────────────────────────

export type MessageChannel = "telegram" | "google-chat" | "ellie-chat";
export type MessageRecordType = "message" | "voice_transcript" | "image_caption";

export interface IncomingMessage {
  /** Supabase message ID */
  id: string;
  /** "user" or "assistant" */
  role: string;
  /** Message content */
  content: string;
  /** Channel source */
  channel: MessageChannel;
  /** Channel-specific metadata from saveMessage */
  metadata?: Record<string, unknown>;
  /** Sender identifier (Telegram user ID, email, etc.) */
  userId?: string;
  /** When the message was created */
  timestamp?: Date;
}

export interface NormalizedMessagePayload {
  role: string;
  content: string;
  channel: MessageChannel;
  sender: string | null;
  record_type: MessageRecordType;
  conversation_context: {
    user_id: string | null;
    channel_metadata: Record<string, unknown>;
  };
}

// ── Channel Toggle ───────────────────────────────────────────

const _enabledChannels = new Set<MessageChannel>([
  "telegram",
  "google-chat",
  "ellie-chat",
]);

let _ingestionEnabled = true;

/** Enable or disable ingestion globally. */
export function setIngestionEnabled(enabled: boolean): void {
  _ingestionEnabled = enabled;
  logger.info(`Ingestion ${enabled ? "enabled" : "disabled"}`);
}

/** Check if ingestion is globally enabled. */
export function isIngestionEnabled(): boolean {
  return _ingestionEnabled;
}

/** Enable ingestion for a specific channel. */
export function enableChannel(channel: MessageChannel): void {
  _enabledChannels.add(channel);
  logger.info(`Channel enabled for ingestion: ${channel}`);
}

/** Disable ingestion for a specific channel. */
export function disableChannel(channel: MessageChannel): void {
  _enabledChannels.delete(channel);
  logger.info(`Channel disabled for ingestion: ${channel}`);
}

/** Check if a channel is enabled for ingestion. */
export function isChannelEnabled(channel: MessageChannel): boolean {
  return _enabledChannels.has(channel);
}

/** Get all enabled channels. */
export function getEnabledChannels(): MessageChannel[] {
  return Array.from(_enabledChannels);
}

// ── Message Normalization ────────────────────────────────────

/**
 * Detect the record type from message content and metadata.
 */
export function detectRecordType(
  content: string,
  metadata?: Record<string, unknown>,
): MessageRecordType {
  if (metadata?.image_name || metadata?.image_mime) {
    return "image_caption";
  }
  if (
    metadata?.voice_transcript ||
    metadata?.transcription ||
    metadata?.is_voice
  ) {
    return "voice_transcript";
  }
  return "message";
}

/**
 * Resolve the sender identifier from channel-specific data.
 */
export function resolveSender(
  channel: MessageChannel,
  userId?: string,
  metadata?: Record<string, unknown>,
): string | null {
  switch (channel) {
    case "telegram":
      return userId ?? null;
    case "google-chat":
      return (metadata?.sender as string) ?? userId ?? null;
    case "ellie-chat":
      return userId ?? null;
    default:
      return userId ?? null;
  }
}

/**
 * Normalize an incoming message into a structured payload
 * suitable for mountain_records.
 */
export function normalizeMessage(msg: IncomingMessage): NormalizedMessagePayload {
  const recordType = detectRecordType(msg.content, msg.metadata);
  const sender = resolveSender(msg.channel, msg.userId, msg.metadata);

  return {
    role: msg.role,
    content: msg.content,
    channel: msg.channel,
    sender,
    record_type: recordType,
    conversation_context: {
      user_id: msg.userId ?? null,
      channel_metadata: msg.metadata ?? {},
    },
  };
}

// ── Real-Time Ingestion ──────────────────────────────────────

/**
 * Ingest a single message into mountain_records.
 * Designed to be called as a fire-and-forget hook from saveMessage().
 *
 * Returns the record ID on success, null on skip/failure.
 */
export async function ingestMessage(msg: IncomingMessage): Promise<string | null> {
  if (!_ingestionEnabled) return null;
  if (!isChannelEnabled(msg.channel)) return null;
  if (!msg.id) return null;

  const payload = normalizeMessage(msg);
  const externalId = `relay:${msg.channel}:${msg.id}`;

  try {
    const record = await upsertRecord({
      record_type: payload.record_type,
      source_system: "relay",
      external_id: externalId,
      payload: payload as unknown as Record<string, unknown>,
      summary: truncateSummary(msg.content),
      status: "active",
      source_timestamp: msg.timestamp ?? new Date(),
    });

    logger.debug("Message ingested", {
      messageId: msg.id,
      channel: msg.channel,
      recordType: payload.record_type,
      mountainRecordId: record.id,
    });

    // Emit UMS domain event — ELLIE-664
    emitDomainEvent({
      record_id: record.id,
      domain: "personal_messages",
      event_type: record.version > 1 ? "record_updated" : "record_created",
      source_system: "relay",
      external_id: externalId,
      record_type: payload.record_type,
      extra: {
        channel: msg.channel,
        role: msg.role,
        sender: payload.sender,
      },
    }).catch(() => {}); // fire-and-forget

    return record.id;
  } catch (err) {
    logger.error("Message ingestion failed", {
      messageId: msg.id,
      channel: msg.channel,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Truncate content to a reasonable summary length. */
function truncateSummary(content: string, maxLen = 200): string {
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen - 3) + "...";
}

// ── MountainSource Implementation (Batch Re-Harvest) ─────────

/**
 * MessageIngestionSource — batch harvester for relay messages.
 *
 * This is registered with MountainOrchestrator for on-demand
 * re-harvesting of historical messages. For real-time ingestion,
 * use ingestMessage() directly.
 */
export class MessageIngestionSource implements MountainSource {
  readonly id = "relay-messages";
  readonly name = "Relay Messages";
  status: SourceStatus = "idle";

  private fetchMessagesFn: MessageFetcher;

  constructor(fetchMessages: MessageFetcher) {
    this.fetchMessagesFn = fetchMessages;
  }

  async harvest(job: HarvestJob): Promise<HarvestResult> {
    const startedAt = new Date();
    const items: HarvestItem[] = [];
    const errors: HarvestError[] = [];
    const limit = job.limit ?? 100;

    this.status = "harvesting";

    try {
      const channels = (job.filters?.channels as MessageChannel[]) ?? [
        "telegram",
        "google-chat",
        "ellie-chat",
      ];
      const role = (job.filters?.role as string) ?? undefined;

      const messages = await this.fetchMessagesFn({
        channels,
        role,
        since: job.since,
        until: job.until,
        limit,
      });

      for (const msg of messages) {
        try {
          const payload = normalizeMessage(msg);
          items.push({
            externalId: `relay:${msg.channel}:${msg.id}`,
            content: msg.content,
            sourceTimestamp: msg.timestamp ?? new Date(),
            metadata: payload as unknown as Record<string, unknown>,
          });
        } catch (err) {
          errors.push({
            message: `Failed to normalize message ${msg.id}: ${err instanceof Error ? err.message : String(err)}`,
            retryable: false,
          });
        }
      }

      this.status = "idle";
    } catch (err) {
      this.status = "error";
      errors.push({
        message: `Batch fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
      });
    }

    return {
      jobId: job.id,
      sourceId: this.id,
      items,
      errors,
      startedAt,
      completedAt: new Date(),
      truncated: items.length >= limit,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.fetchMessagesFn({ channels: ["telegram"], limit: 1 });
      return true;
    } catch {
      return false;
    }
  }
}

// ── Fetcher Type ─────────────────────────────────────────────

export interface MessageFetchOptions {
  channels?: MessageChannel[];
  role?: string;
  since?: Date;
  until?: Date;
  limit?: number;
}

export type MessageFetcher = (
  opts: MessageFetchOptions,
) => Promise<IncomingMessage[]>;

// ── Testing Helpers ──────────────────────────────────────────

/** Reset ingestion state for testing. */
export function _resetIngestionForTesting(): void {
  _ingestionEnabled = true;
  _enabledChannels.clear();
  _enabledChannels.add("telegram");
  _enabledChannels.add("google-chat");
  _enabledChannels.add("ellie-chat");
}
