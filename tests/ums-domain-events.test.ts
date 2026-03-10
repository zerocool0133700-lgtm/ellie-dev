/**
 * UMS Domain Events Tests — ELLIE-664
 *
 * Tests domain_event content type flowing through the UMS push pipeline.
 * Verifies: event structure, consumer delivery, filtering, Mountain
 * ingestion integration, and no breaking changes to existing types.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { sql } from "../../ellie-forest/src/index.ts";
import {
  emitDomainEvent,
  _buildDomainEventMessage,
  type DomainEventPayload,
} from "../src/ums/domain-events.ts";
import {
  subscribe,
  unsubscribe,
  notify,
} from "../src/ums/events.ts";
import type { UnifiedMessage } from "../src/ums/types.ts";
import {
  ingestMessage,
  _resetIngestionForTesting,
  type IncomingMessage,
} from "../src/mountain/message-ingestion.ts";

// ── Test Helpers ─────────────────────────────────────────────

const TEST_PREFIX = "test-domain-";
const captured: UnifiedMessage[] = [];

function captureHandler(msg: UnifiedMessage): void {
  captured.push(msg);
}

function makePayload(overrides: Partial<DomainEventPayload> = {}): DomainEventPayload {
  return {
    record_id: `${TEST_PREFIX}${crypto.randomUUID()}`,
    domain: "personal_messages",
    event_type: "record_created",
    source_system: "relay",
    external_id: `relay:telegram:msg-${crypto.randomUUID()}`,
    record_type: "message",
    ...overrides,
  };
}

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: `${TEST_PREFIX}${crypto.randomUUID()}`,
    role: "user",
    content: "Domain event test message",
    channel: "telegram",
    metadata: {},
    userId: "test-user",
    timestamp: new Date("2026-03-10T12:00:00Z"),
    ...overrides,
  };
}

// ── Cleanup ──────────────────────────────────────────────────

beforeEach(() => {
  captured.length = 0;
  _resetIngestionForTesting();
});

afterEach(() => {
  unsubscribe("test-domain-consumer");
  unsubscribe("test-domain-filtered");
  unsubscribe("test-all-consumer");
  unsubscribe("test-channel-consumer");
});

async function cleanupTestRecords() {
  await sql`
    DELETE FROM mountain_records
    WHERE source_system = 'relay'
      AND external_id LIKE ${"relay:%:" + TEST_PREFIX + "%"}
  `;
}

afterAll(async () => {
  await cleanupTestRecords();
});

// ── _buildDomainEventMessage ─────────────────────────────────

describe("_buildDomainEventMessage", () => {
  test("builds a UnifiedMessage with domain_event content type", () => {
    const payload = makePayload();
    const msg = _buildDomainEventMessage(payload);

    expect(msg.content_type).toBe("domain_event");
    expect(msg.provider).toBe("mountain");
    expect(msg.id).toBeTruthy();
  });

  test("sets channel to mountain:{domain}", () => {
    const msg = _buildDomainEventMessage(makePayload({ domain: "work_items" }));
    expect(msg.channel).toBe("mountain:work_items");
  });

  test("sets provider_id with source, external_id, event_type", () => {
    const payload = makePayload({
      source_system: "relay",
      external_id: "relay:tg:123",
      event_type: "record_created",
    });
    const msg = _buildDomainEventMessage(payload);
    expect(msg.provider_id).toBe("relay:relay:tg:123:record_created");
  });

  test("includes record_id in metadata", () => {
    const payload = makePayload({ record_id: "abc-123" });
    const msg = _buildDomainEventMessage(payload);
    expect(msg.metadata.record_id).toBe("abc-123");
  });

  test("includes domain in metadata", () => {
    const payload = makePayload({ domain: "contacts" });
    const msg = _buildDomainEventMessage(payload);
    expect(msg.metadata.domain).toBe("contacts");
  });

  test("includes event_type in metadata", () => {
    const payload = makePayload({ event_type: "record_updated" });
    const msg = _buildDomainEventMessage(payload);
    expect(msg.metadata.event_type).toBe("record_updated");
  });

  test("includes source_system in metadata", () => {
    const payload = makePayload({ source_system: "plane" });
    const msg = _buildDomainEventMessage(payload);
    expect(msg.metadata.source_system).toBe("plane");
  });

  test("includes extra fields in metadata", () => {
    const payload = makePayload({
      extra: { channel: "telegram", role: "user" },
    });
    const msg = _buildDomainEventMessage(payload);
    expect(msg.metadata.channel).toBe("telegram");
    expect(msg.metadata.role).toBe("user");
  });

  test("sets content as descriptive string", () => {
    const payload = makePayload({
      event_type: "record_created",
      record_type: "message",
      source_system: "relay",
    });
    const msg = _buildDomainEventMessage(payload);
    expect(msg.content).toBe("[record_created] message from relay");
  });

  test("raw field contains the full payload", () => {
    const payload = makePayload();
    const msg = _buildDomainEventMessage(payload);
    expect((msg.raw as any).record_id).toBe(payload.record_id);
    expect((msg.raw as any).domain).toBe(payload.domain);
  });

  test("sets received_at and provider_timestamp", () => {
    const msg = _buildDomainEventMessage(makePayload());
    expect(msg.received_at).toBeTruthy();
    expect(msg.provider_timestamp).toBeTruthy();
  });

  test("sender is null for domain events", () => {
    const msg = _buildDomainEventMessage(makePayload());
    expect(msg.sender).toBeNull();
  });
});

// ── emitDomainEvent + push pipeline ──────────────────────────

describe("emitDomainEvent", () => {
  test("delivers domain_event to subscribed consumer", async () => {
    subscribe("test-domain-consumer", { content_type: "domain_event" }, captureHandler);

    await emitDomainEvent(makePayload());

    expect(captured).toHaveLength(1);
    expect(captured[0].content_type).toBe("domain_event");
    expect(captured[0].provider).toBe("mountain");
  });

  test("delivers to consumer with no filter (catch-all)", async () => {
    subscribe("test-all-consumer", {}, captureHandler);

    await emitDomainEvent(makePayload());

    expect(captured).toHaveLength(1);
    expect(captured[0].content_type).toBe("domain_event");
  });

  test("does NOT deliver to consumer filtering for different content_type", async () => {
    subscribe("test-domain-filtered", { content_type: "text" }, captureHandler);

    await emitDomainEvent(makePayload());

    expect(captured).toHaveLength(0);
  });

  test("delivers to consumer filtering by provider", async () => {
    subscribe("test-domain-consumer", { provider: "mountain" }, captureHandler);

    await emitDomainEvent(makePayload());

    expect(captured).toHaveLength(1);
  });

  test("does NOT deliver to consumer filtering for different provider", async () => {
    subscribe("test-domain-filtered", { provider: "telegram" }, captureHandler);

    await emitDomainEvent(makePayload());

    expect(captured).toHaveLength(0);
  });

  test("delivers to consumer filtering by channel glob", async () => {
    subscribe("test-channel-consumer", { channel: "mountain:*" }, captureHandler);

    await emitDomainEvent(makePayload({ domain: "personal_messages" }));

    expect(captured).toHaveLength(1);
  });

  test("delivers to consumer filtering by exact channel", async () => {
    subscribe("test-channel-consumer", { channel: "mountain:work_items" }, captureHandler);

    await emitDomainEvent(makePayload({ domain: "work_items" }));

    expect(captured).toHaveLength(1);
  });

  test("does NOT deliver to consumer filtering for different channel", async () => {
    subscribe("test-channel-consumer", { channel: "mountain:contacts" }, captureHandler);

    await emitDomainEvent(makePayload({ domain: "personal_messages" }));

    expect(captured).toHaveLength(0);
  });

  test("multiple consumers all receive the event", async () => {
    const captured2: UnifiedMessage[] = [];
    subscribe("test-domain-consumer", { content_type: "domain_event" }, captureHandler);
    subscribe("test-all-consumer", {}, (msg) => { captured2.push(msg); });

    await emitDomainEvent(makePayload());

    expect(captured).toHaveLength(1);
    expect(captured2).toHaveLength(1);
  });

  test("consumer error does not crash emitDomainEvent", async () => {
    subscribe("test-domain-consumer", { content_type: "domain_event" }, () => {
      throw new Error("Consumer exploded");
    });

    // Should not throw
    await emitDomainEvent(makePayload());
  });

  test("record_created event type flows through", async () => {
    subscribe("test-domain-consumer", { content_type: "domain_event" }, captureHandler);

    await emitDomainEvent(makePayload({ event_type: "record_created" }));

    expect(captured[0].metadata.event_type).toBe("record_created");
  });

  test("record_updated event type flows through", async () => {
    subscribe("test-domain-consumer", { content_type: "domain_event" }, captureHandler);

    await emitDomainEvent(makePayload({ event_type: "record_updated" }));

    expect(captured[0].metadata.event_type).toBe("record_updated");
  });

  test("record_archived event type flows through", async () => {
    subscribe("test-domain-consumer", { content_type: "domain_event" }, captureHandler);

    await emitDomainEvent(makePayload({ event_type: "record_archived" }));

    expect(captured[0].metadata.event_type).toBe("record_archived");
  });
});

// ── Integration: Mountain ingestion → domain event ───────────

describe("Mountain ingestion emits domain events", () => {
  beforeEach(async () => {
    await cleanupTestRecords();
  });

  test("new message ingestion emits record_created", async () => {
    subscribe("test-domain-consumer", { content_type: "domain_event" }, captureHandler);

    const msg = makeMsg();
    const recordId = await ingestMessage(msg);

    expect(recordId).not.toBeNull();

    // Give the fire-and-forget emitDomainEvent a tick to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(captured).toHaveLength(1);
    expect(captured[0].metadata.event_type).toBe("record_created");
    expect(captured[0].metadata.record_id).toBe(recordId);
    expect(captured[0].metadata.domain).toBe("personal_messages");
    expect(captured[0].metadata.source_system).toBe("relay");
  });

  test("re-ingesting same message emits record_updated", async () => {
    subscribe("test-domain-consumer", { content_type: "domain_event" }, captureHandler);

    const msg = makeMsg();
    await ingestMessage(msg);
    await new Promise((r) => setTimeout(r, 50));

    captured.length = 0;

    // Re-ingest same message (same ID → upsert bumps version)
    msg.content = "Updated content";
    await ingestMessage(msg);
    await new Promise((r) => setTimeout(r, 50));

    expect(captured).toHaveLength(1);
    expect(captured[0].metadata.event_type).toBe("record_updated");
  });

  test("domain event includes channel and role in extra", async () => {
    subscribe("test-domain-consumer", { content_type: "domain_event" }, captureHandler);

    const msg = makeMsg({ channel: "google-chat", role: "assistant" });
    await ingestMessage(msg);
    await new Promise((r) => setTimeout(r, 50));

    expect(captured).toHaveLength(1);
    expect(captured[0].metadata.channel).toBe("google-chat");
    expect(captured[0].metadata.role).toBe("assistant");
  });

  test("domain event has correct record_type for voice", async () => {
    subscribe("test-domain-consumer", { content_type: "domain_event" }, captureHandler);

    const msg = makeMsg({ metadata: { voice_transcript: true } });
    await ingestMessage(msg);
    await new Promise((r) => setTimeout(r, 50));

    expect(captured).toHaveLength(1);
    expect(captured[0].metadata.record_type).toBe("voice_transcript");
  });

  test("domain event has correct record_type for image", async () => {
    subscribe("test-domain-consumer", { content_type: "domain_event" }, captureHandler);

    const msg = makeMsg({ metadata: { image_name: "pic.jpg" } });
    await ingestMessage(msg);
    await new Promise((r) => setTimeout(r, 50));

    expect(captured).toHaveLength(1);
    expect(captured[0].metadata.record_type).toBe("image_caption");
  });

  test("skipped ingestion does not emit domain event", async () => {
    subscribe("test-domain-consumer", { content_type: "domain_event" }, captureHandler);

    // No ID → ingestion skipped
    await ingestMessage(makeMsg({ id: "" }));
    await new Promise((r) => setTimeout(r, 50));

    expect(captured).toHaveLength(0);
  });
});

// ── Existing content types not broken ────────────────────────

describe("backward compatibility", () => {
  test("text content type still works with notify", async () => {
    const textCaptured: UnifiedMessage[] = [];
    subscribe("test-domain-consumer", { content_type: "text" }, (msg) => textCaptured.push(msg));

    const textMsg: UnifiedMessage = {
      id: crypto.randomUUID(),
      provider: "telegram",
      provider_id: "tg:123",
      channel: "telegram:42",
      sender: { name: "Dave" },
      content: "Hello",
      content_type: "text",
      raw: {},
      received_at: new Date().toISOString(),
      provider_timestamp: null,
      metadata: {},
    };

    await notify(textMsg);

    expect(textCaptured).toHaveLength(1);
    expect(textCaptured[0].content_type).toBe("text");
  });

  test("notification content type still works", async () => {
    const notifCaptured: UnifiedMessage[] = [];
    subscribe("test-domain-consumer", { content_type: "notification" }, (msg) => notifCaptured.push(msg));

    const notifMsg: UnifiedMessage = {
      id: crypto.randomUUID(),
      provider: "github",
      provider_id: "gh:456",
      channel: null,
      sender: null,
      content: "PR merged",
      content_type: "notification",
      raw: {},
      received_at: new Date().toISOString(),
      provider_timestamp: null,
      metadata: {},
    };

    await notify(notifMsg);

    expect(notifCaptured).toHaveLength(1);
  });

  test("domain_event does not interfere with text subscriber", async () => {
    const textOnly: UnifiedMessage[] = [];
    subscribe("test-domain-filtered", { content_type: "text" }, (msg) => textOnly.push(msg));

    await emitDomainEvent(makePayload());

    expect(textOnly).toHaveLength(0);
  });
});
