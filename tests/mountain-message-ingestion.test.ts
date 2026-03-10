/**
 * Mountain Message Ingestion Tests — ELLIE-660
 *
 * Tests message normalization, record type detection, channel toggles,
 * real-time ingestion, and batch re-harvesting via MessageIngestionSource.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { sql } from "../../ellie-forest/src/index.ts";
import {
  normalizeMessage,
  detectRecordType,
  resolveSender,
  ingestMessage,
  setIngestionEnabled,
  isIngestionEnabled,
  enableChannel,
  disableChannel,
  isChannelEnabled,
  getEnabledChannels,
  MessageIngestionSource,
  _resetIngestionForTesting,
  type IncomingMessage,
  type MessageChannel,
  type MessageFetchOptions,
} from "../src/mountain/message-ingestion.ts";

// ── Test Constants ───────────────────────────────────────────

const TEST_SOURCE = "relay";
const TEST_PREFIX = "test-ingest-";

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: `${TEST_PREFIX}${crypto.randomUUID()}`,
    role: "user",
    content: "Hello from test",
    channel: "telegram",
    metadata: {},
    userId: "user-123",
    timestamp: new Date("2026-03-10T12:00:00Z"),
    ...overrides,
  };
}

// ── Cleanup ──────────────────────────────────────────────────

async function cleanupTestRecords() {
  await sql`
    DELETE FROM mountain_records
    WHERE source_system = ${TEST_SOURCE}
      AND external_id LIKE ${"relay:%:" + TEST_PREFIX + "%"}
  `;
}

beforeEach(async () => {
  _resetIngestionForTesting();
  await cleanupTestRecords();
});

afterAll(async () => {
  await cleanupTestRecords();
});

// ── detectRecordType ─────────────────────────────────────────

describe("detectRecordType", () => {
  test("returns 'message' for plain text", () => {
    expect(detectRecordType("Hello world")).toBe("message");
  });

  test("returns 'message' for empty metadata", () => {
    expect(detectRecordType("Hello", {})).toBe("message");
  });

  test("returns 'image_caption' when image_name present", () => {
    expect(detectRecordType("A cat photo", { image_name: "cat.jpg" })).toBe("image_caption");
  });

  test("returns 'image_caption' when image_mime present", () => {
    expect(detectRecordType("Photo", { image_mime: "image/png" })).toBe("image_caption");
  });

  test("returns 'voice_transcript' when voice_transcript flag present", () => {
    expect(detectRecordType("Transcribed text", { voice_transcript: true })).toBe("voice_transcript");
  });

  test("returns 'voice_transcript' when transcription metadata present", () => {
    expect(detectRecordType("Speech", { transcription: "Speech" })).toBe("voice_transcript");
  });

  test("returns 'voice_transcript' when is_voice flag present", () => {
    expect(detectRecordType("Voice note", { is_voice: true })).toBe("voice_transcript");
  });

  test("image takes precedence over voice when both present", () => {
    expect(detectRecordType("Image+voice", { image_name: "x.jpg", is_voice: true })).toBe("image_caption");
  });
});

// ── resolveSender ────────────────────────────────────────────

describe("resolveSender", () => {
  test("returns userId for telegram", () => {
    expect(resolveSender("telegram", "12345")).toBe("12345");
  });

  test("returns null for telegram with no userId", () => {
    expect(resolveSender("telegram")).toBeNull();
  });

  test("returns metadata.sender for google-chat", () => {
    expect(resolveSender("google-chat", "fallback@email.com", {
      sender: "dave@ellie-labs.dev",
    })).toBe("dave@ellie-labs.dev");
  });

  test("falls back to userId for google-chat without metadata.sender", () => {
    expect(resolveSender("google-chat", "dave@gmail.com", {})).toBe("dave@gmail.com");
  });

  test("returns userId for ellie-chat", () => {
    expect(resolveSender("ellie-chat", "anon-abc")).toBe("anon-abc");
  });

  test("returns null when no userId and no metadata", () => {
    expect(resolveSender("ellie-chat")).toBeNull();
  });
});

// ── normalizeMessage ─────────────────────────────────────────

describe("normalizeMessage", () => {
  test("normalizes a telegram message", () => {
    const msg = makeMsg({ channel: "telegram", userId: "tg-42" });
    const result = normalizeMessage(msg);

    expect(result.role).toBe("user");
    expect(result.content).toBe("Hello from test");
    expect(result.channel).toBe("telegram");
    expect(result.sender).toBe("tg-42");
    expect(result.record_type).toBe("message");
    expect(result.conversation_context.user_id).toBe("tg-42");
  });

  test("normalizes a google-chat message with sender metadata", () => {
    const msg = makeMsg({
      channel: "google-chat",
      userId: "dave@gmail.com",
      metadata: { sender: "dave@ellie-labs.dev", space: "spaces/ABC123" },
    });
    const result = normalizeMessage(msg);

    expect(result.channel).toBe("google-chat");
    expect(result.sender).toBe("dave@ellie-labs.dev");
    expect(result.conversation_context.channel_metadata).toEqual({
      sender: "dave@ellie-labs.dev",
      space: "spaces/ABC123",
    });
  });

  test("normalizes an ellie-chat message with image", () => {
    const msg = makeMsg({
      channel: "ellie-chat",
      content: "Check this out",
      metadata: { image_name: "screenshot.png", image_mime: "image/png" },
    });
    const result = normalizeMessage(msg);

    expect(result.record_type).toBe("image_caption");
    expect(result.channel).toBe("ellie-chat");
  });

  test("normalizes a voice transcript", () => {
    const msg = makeMsg({
      content: "Transcribed voice message",
      metadata: { voice_transcript: true },
    });
    const result = normalizeMessage(msg);

    expect(result.record_type).toBe("voice_transcript");
  });

  test("normalizes an assistant message", () => {
    const msg = makeMsg({ role: "assistant" });
    const result = normalizeMessage(msg);

    expect(result.role).toBe("assistant");
  });

  test("handles missing metadata gracefully", () => {
    const msg = makeMsg({ metadata: undefined, userId: undefined });
    const result = normalizeMessage(msg);

    expect(result.sender).toBeNull();
    expect(result.conversation_context.user_id).toBeNull();
    expect(result.conversation_context.channel_metadata).toEqual({});
  });
});

// ── Channel Toggle ───────────────────────────────────────────

describe("channel toggle", () => {
  test("all channels enabled by default", () => {
    const channels = getEnabledChannels();
    expect(channels).toContain("telegram");
    expect(channels).toContain("google-chat");
    expect(channels).toContain("ellie-chat");
  });

  test("can disable a channel", () => {
    disableChannel("telegram");
    expect(isChannelEnabled("telegram")).toBe(false);
    expect(isChannelEnabled("google-chat")).toBe(true);
  });

  test("can re-enable a channel", () => {
    disableChannel("telegram");
    enableChannel("telegram");
    expect(isChannelEnabled("telegram")).toBe(true);
  });

  test("global toggle disables all ingestion", () => {
    setIngestionEnabled(false);
    expect(isIngestionEnabled()).toBe(false);
  });

  test("global toggle re-enables ingestion", () => {
    setIngestionEnabled(false);
    setIngestionEnabled(true);
    expect(isIngestionEnabled()).toBe(true);
  });

  test("reset restores defaults", () => {
    disableChannel("telegram");
    disableChannel("google-chat");
    setIngestionEnabled(false);
    _resetIngestionForTesting();
    expect(isIngestionEnabled()).toBe(true);
    expect(isChannelEnabled("telegram")).toBe(true);
    expect(isChannelEnabled("google-chat")).toBe(true);
    expect(isChannelEnabled("ellie-chat")).toBe(true);
  });
});

// ── ingestMessage (real-time, writes to DB) ──────────────────

describe("ingestMessage", () => {
  test("ingests a telegram message to mountain_records", async () => {
    const msg = makeMsg({ channel: "telegram" });
    const recordId = await ingestMessage(msg);

    expect(recordId).not.toBeNull();

    const [row] = await sql`
      SELECT * FROM mountain_records WHERE id = ${recordId!}
    `;
    expect(row).toBeDefined();
    expect(row.source_system).toBe("relay");
    expect(row.external_id).toBe(`relay:telegram:${msg.id}`);
    expect(row.record_type).toBe("message");
    expect(row.status).toBe("active");
    expect(row.payload.content).toBe("Hello from test");
    expect(row.payload.channel).toBe("telegram");
    expect(row.payload.sender).toBe("user-123");
  });

  test("ingests a google-chat message", async () => {
    const msg = makeMsg({
      channel: "google-chat",
      content: "Hey from GChat",
      metadata: { sender: "dave@ellie-labs.dev" },
    });
    const recordId = await ingestMessage(msg);

    expect(recordId).not.toBeNull();

    const [row] = await sql`
      SELECT * FROM mountain_records WHERE id = ${recordId!}
    `;
    expect(row.payload.channel).toBe("google-chat");
    expect(row.payload.sender).toBe("dave@ellie-labs.dev");
  });

  test("ingests an ellie-chat message", async () => {
    const msg = makeMsg({ channel: "ellie-chat", userId: "anon-xyz" });
    const recordId = await ingestMessage(msg);

    expect(recordId).not.toBeNull();

    const [row] = await sql`
      SELECT * FROM mountain_records WHERE id = ${recordId!}
    `;
    expect(row.payload.channel).toBe("ellie-chat");
    expect(row.payload.sender).toBe("anon-xyz");
  });

  test("ingests a voice transcript", async () => {
    const msg = makeMsg({
      content: "Voice note text",
      metadata: { voice_transcript: true },
    });
    const recordId = await ingestMessage(msg);

    const [row] = await sql`
      SELECT * FROM mountain_records WHERE id = ${recordId!}
    `;
    expect(row.record_type).toBe("voice_transcript");
  });

  test("ingests an image caption", async () => {
    const msg = makeMsg({
      content: "A beautiful sunset",
      metadata: { image_name: "sunset.jpg", image_mime: "image/jpeg" },
    });
    const recordId = await ingestMessage(msg);

    const [row] = await sql`
      SELECT * FROM mountain_records WHERE id = ${recordId!}
    `;
    expect(row.record_type).toBe("image_caption");
  });

  test("upserts on duplicate message ID", async () => {
    const msg = makeMsg({ content: "Version 1" });
    const id1 = await ingestMessage(msg);

    msg.content = "Version 2";
    const id2 = await ingestMessage(msg);

    // Same record, updated in place
    expect(id1).toBe(id2);

    const [row] = await sql`
      SELECT * FROM mountain_records WHERE id = ${id1!}
    `;
    expect(row.payload.content).toBe("Version 2");
    expect(row.version).toBe(2);
  });

  test("truncates summary for long content", async () => {
    const longContent = "A".repeat(500);
    const msg = makeMsg({ content: longContent });
    const recordId = await ingestMessage(msg);

    const [row] = await sql`
      SELECT * FROM mountain_records WHERE id = ${recordId!}
    `;
    expect(row.summary.length).toBeLessThanOrEqual(200);
    expect(row.summary.endsWith("...")).toBe(true);
  });

  test("skips ingestion when globally disabled", async () => {
    setIngestionEnabled(false);
    const result = await ingestMessage(makeMsg());
    expect(result).toBeNull();
  });

  test("skips ingestion when channel is disabled", async () => {
    disableChannel("telegram");
    const result = await ingestMessage(makeMsg({ channel: "telegram" }));
    expect(result).toBeNull();
  });

  test("still ingests other channels when one is disabled", async () => {
    disableChannel("telegram");
    const result = await ingestMessage(makeMsg({ channel: "google-chat" }));
    expect(result).not.toBeNull();
  });

  test("skips when message has no ID", async () => {
    const result = await ingestMessage(makeMsg({ id: "" }));
    expect(result).toBeNull();
  });

  test("stores source_timestamp from message", async () => {
    const ts = new Date("2026-01-15T08:30:00Z");
    const msg = makeMsg({ timestamp: ts });
    const recordId = await ingestMessage(msg);

    const [row] = await sql`
      SELECT * FROM mountain_records WHERE id = ${recordId!}
    `;
    expect(new Date(row.source_timestamp).toISOString()).toBe(ts.toISOString());
  });
});

// ── MessageIngestionSource (batch harvest) ───────────────────

describe("MessageIngestionSource", () => {
  function makeFetcher(messages: IncomingMessage[]): (opts: MessageFetchOptions) => Promise<IncomingMessage[]> {
    return async (opts) => {
      let result = [...messages];
      if (opts.channels) {
        result = result.filter((m) => opts.channels!.includes(m.channel));
      }
      if (opts.role) {
        result = result.filter((m) => m.role === opts.role);
      }
      if (opts.since) {
        result = result.filter((m) => (m.timestamp ?? new Date()) >= opts.since!);
      }
      if (opts.until) {
        result = result.filter((m) => (m.timestamp ?? new Date()) < opts.until!);
      }
      if (opts.limit) {
        result = result.slice(0, opts.limit);
      }
      return result;
    };
  }

  const sampleMessages: IncomingMessage[] = [
    makeMsg({ id: "batch-1", channel: "telegram", content: "TG msg", timestamp: new Date("2026-03-10T10:00:00Z") }),
    makeMsg({ id: "batch-2", channel: "google-chat", content: "GChat msg", timestamp: new Date("2026-03-10T11:00:00Z") }),
    makeMsg({ id: "batch-3", channel: "ellie-chat", content: "EC msg", timestamp: new Date("2026-03-10T12:00:00Z") }),
    makeMsg({ id: "batch-4", channel: "telegram", role: "assistant", content: "Reply", timestamp: new Date("2026-03-10T13:00:00Z") }),
  ];

  test("harvests all messages", async () => {
    const source = new MessageIngestionSource(makeFetcher(sampleMessages));
    const result = await source.harvest({
      id: "test-job-1",
      sourceId: "relay-messages",
      limit: 100,
    });

    expect(result.items).toHaveLength(4);
    expect(result.errors).toHaveLength(0);
    expect(result.truncated).toBe(false);
    expect(result.sourceId).toBe("relay-messages");
  });

  test("filters by channel", async () => {
    const source = new MessageIngestionSource(makeFetcher(sampleMessages));
    const result = await source.harvest({
      id: "test-job-2",
      sourceId: "relay-messages",
      filters: { channels: ["telegram"] },
    });

    expect(result.items).toHaveLength(2);
    expect(result.items.every((i) => i.externalId.includes("telegram"))).toBe(true);
  });

  test("filters by role", async () => {
    const source = new MessageIngestionSource(makeFetcher(sampleMessages));
    const result = await source.harvest({
      id: "test-job-3",
      sourceId: "relay-messages",
      filters: { role: "assistant" },
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].content).toBe("Reply");
  });

  test("respects time window", async () => {
    const source = new MessageIngestionSource(makeFetcher(sampleMessages));
    const result = await source.harvest({
      id: "test-job-4",
      sourceId: "relay-messages",
      since: new Date("2026-03-10T11:00:00Z"),
      until: new Date("2026-03-10T13:00:00Z"),
    });

    expect(result.items).toHaveLength(2);
  });

  test("respects limit and marks truncated", async () => {
    const source = new MessageIngestionSource(makeFetcher(sampleMessages));
    const result = await source.harvest({
      id: "test-job-5",
      sourceId: "relay-messages",
      limit: 2,
    });

    expect(result.items).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  test("handles fetch error gracefully", async () => {
    const failFetcher = async () => {
      throw new Error("DB connection lost");
    };
    const source = new MessageIngestionSource(failFetcher);
    const result = await source.harvest({
      id: "test-job-6",
      sourceId: "relay-messages",
    });

    expect(result.items).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("DB connection lost");
    expect(result.errors[0].retryable).toBe(true);
    expect(source.status).toBe("error");
  });

  test("sets status during harvest", async () => {
    let capturedStatus: string = "";
    const slowFetcher = async () => {
      capturedStatus = source.status;
      return [];
    };
    const source = new MessageIngestionSource(slowFetcher);
    await source.harvest({ id: "test-job-7", sourceId: "relay-messages" });

    expect(capturedStatus).toBe("harvesting");
    expect(source.status).toBe("idle");
  });

  test("healthCheck succeeds with working fetcher", async () => {
    const source = new MessageIngestionSource(makeFetcher([]));
    expect(await source.healthCheck()).toBe(true);
  });

  test("healthCheck fails with broken fetcher", async () => {
    const source = new MessageIngestionSource(async () => { throw new Error("fail"); });
    expect(await source.healthCheck()).toBe(false);
  });

  test("items have correct externalId format", async () => {
    const source = new MessageIngestionSource(makeFetcher(sampleMessages));
    const result = await source.harvest({
      id: "test-job-8",
      sourceId: "relay-messages",
      limit: 100,
    });

    for (const item of result.items) {
      expect(item.externalId).toMatch(/^relay:(telegram|google-chat|ellie-chat):/);
    }
  });

  test("items include normalized metadata", async () => {
    const source = new MessageIngestionSource(makeFetcher([
      makeMsg({ id: "meta-1", channel: "google-chat", metadata: { sender: "dave@test.com" } }),
    ]));
    const result = await source.harvest({
      id: "test-job-9",
      sourceId: "relay-messages",
    });

    expect(result.items[0].metadata).toBeDefined();
    expect((result.items[0].metadata as any).sender).toBe("dave@test.com");
    expect((result.items[0].metadata as any).channel).toBe("google-chat");
  });
});
