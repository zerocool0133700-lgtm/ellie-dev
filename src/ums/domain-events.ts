/**
 * UMS Domain Events — ELLIE-664
 *
 * Emits domain_event messages through the UMS push pipeline when
 * Mountain records are created or updated. Push-only (no DB insert) —
 * domain events flow through the EventEmitter to subscribed consumers
 * without being stored in the unified_messages table.
 *
 * Consumers subscribe with { content_type: "domain_event" } and can
 * filter by metadata.domain or metadata.event_type in their handler.
 */

import type { UnifiedMessage } from "./types.ts";
import { notify } from "./events.ts";
import { log } from "../logger.ts";

const logger = log.child("ums-domain-events");

// ── Types ────────────────────────────────────────────────────

export type DomainEventType =
  | "record_created"
  | "record_updated"
  | "record_archived"
  | "record_error"
  | (string & {});

export interface DomainEventPayload {
  /** Mountain record ID */
  record_id: string;
  /** Domain category (e.g. "personal_messages", "work_items", "contacts") */
  domain: string;
  /** What happened */
  event_type: DomainEventType;
  /** Source system that created the record */
  source_system: string;
  /** External ID from the source */
  external_id: string;
  /** Record type (e.g. "message", "voice_transcript", "issue") */
  record_type: string;
  /** Optional extra context */
  extra?: Record<string, unknown>;
}

// ── Emit ─────────────────────────────────────────────────────

/**
 * Emit a domain event through the UMS push pipeline.
 *
 * Creates a synthetic UnifiedMessage with content_type "domain_event"
 * and calls notify() directly. No database insert — this is push-only.
 */
export async function emitDomainEvent(payload: DomainEventPayload): Promise<void> {
  const message: UnifiedMessage = {
    id: crypto.randomUUID(),
    provider: "mountain",
    provider_id: `${payload.source_system}:${payload.external_id}:${payload.event_type}`,
    channel: `mountain:${payload.domain}`,
    sender: null,
    content: `[${payload.event_type}] ${payload.record_type} from ${payload.source_system}`,
    content_type: "domain_event",
    raw: payload as unknown as Record<string, unknown>,
    received_at: new Date().toISOString(),
    provider_timestamp: new Date().toISOString(),
    metadata: {
      record_id: payload.record_id,
      domain: payload.domain,
      event_type: payload.event_type,
      source_system: payload.source_system,
      external_id: payload.external_id,
      record_type: payload.record_type,
      ...payload.extra,
    },
  };

  logger.debug("Domain event emitted", {
    event_type: payload.event_type,
    domain: payload.domain,
    record_id: payload.record_id,
  });

  try {
    await notify(message);
  } catch (err) {
    logger.error("Domain event notification failed", {
      event_type: payload.event_type,
      record_id: payload.record_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Testing Helpers ──────────────────────────────────────────

/** Build a domain event payload for testing without emitting. */
export function _buildDomainEventMessage(payload: DomainEventPayload): UnifiedMessage {
  return {
    id: crypto.randomUUID(),
    provider: "mountain",
    provider_id: `${payload.source_system}:${payload.external_id}:${payload.event_type}`,
    channel: `mountain:${payload.domain}`,
    sender: null,
    content: `[${payload.event_type}] ${payload.record_type} from ${payload.source_system}`,
    content_type: "domain_event",
    raw: payload as unknown as Record<string, unknown>,
    received_at: new Date().toISOString(),
    provider_timestamp: new Date().toISOString(),
    metadata: {
      record_id: payload.record_id,
      domain: payload.domain,
      event_type: payload.event_type,
      source_system: payload.source_system,
      external_id: payload.external_id,
      record_type: payload.record_type,
      ...payload.extra,
    },
  };
}
