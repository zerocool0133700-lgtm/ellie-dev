/**
 * Tests for Mountain Message Backfill — ELLIE-667
 */
import { describe, test, expect } from "bun:test";
import {
  normalizeSupabaseMessage,
  detectBackfillRecordType,
  runBackfill,
  _makeMockSupabaseMessage,
  _makeMockFetcher,
  _makeMockWriter,
  type SupabaseMessage,
  type BackfillProgress,
} from "../src/mountain/message-backfill.ts";

// ── normalizeSupabaseMessage ──────────────────────────────────

describe("normalizeSupabaseMessage", () => {
  test("normalizes a standard text message", () => {
    const msg = _makeMockSupabaseMessage({
      id: "msg-001",
      content: "Hello world",
      channel: "telegram",
      role: "user",
      user_id: "dave",
      conversation_id: "conv-123",
      created_at: "2026-03-10T12:00:00Z",
    });

    const result = normalizeSupabaseMessage(msg);

    expect(result.record_type).toBe("message");
    expect(result.source_system).toBe("relay");
    expect(result.external_id).toBe("backfill:telegram:msg-001");
    expect(result.status).toBe("active");
    expect(result.payload.content).toBe("Hello world");
    expect(result.payload.role).toBe("user");
    expect(result.payload.channel).toBe("telegram");
    expect(result.payload.sender).toBe("dave");
    expect(result.payload.conversation_id).toBe("conv-123");
    expect(result.payload.backfilled).toBe(true);
    expect(result.payload.metadata).toEqual({});
    expect(result.source_timestamp).toEqual(new Date("2026-03-10T12:00:00Z"));
  });

  test("handles null user_id and conversation_id", () => {
    const msg = _makeMockSupabaseMessage({
      user_id: null,
      conversation_id: null,
    });

    const result = normalizeSupabaseMessage(msg);
    expect(result.payload.sender).toBeNull();
    expect(result.payload.conversation_id).toBeNull();
  });

  test("handles null metadata", () => {
    const msg = _makeMockSupabaseMessage({ metadata: null });
    const result = normalizeSupabaseMessage(msg);
    expect(result.payload.metadata).toEqual({});
  });

  test("truncates long content in summary", () => {
    const longContent = "A".repeat(300);
    const msg = _makeMockSupabaseMessage({ content: longContent });

    const result = normalizeSupabaseMessage(msg);
    expect(result.summary.length).toBe(200);
    expect(result.summary.endsWith("...")).toBe(true);
  });

  test("keeps short content in summary without truncation", () => {
    const msg = _makeMockSupabaseMessage({ content: "Short message" });
    const result = normalizeSupabaseMessage(msg);
    expect(result.summary).toBe("Short message");
  });

  test("uses 'unknown' channel when channel is null-ish", () => {
    const msg = _makeMockSupabaseMessage();
    // Override channel to empty-ish — the ?? only catches null/undefined
    (msg as any).channel = null;
    const result = normalizeSupabaseMessage(msg);
    expect(result.payload.channel).toBe("unknown");
  });

  test("preserves metadata in payload", () => {
    const msg = _makeMockSupabaseMessage({
      metadata: { custom_field: "value", nested: { a: 1 } },
    });
    const result = normalizeSupabaseMessage(msg);
    expect(result.payload.metadata).toEqual({ custom_field: "value", nested: { a: 1 } });
  });
});

// ── detectBackfillRecordType ──────────────────────────────────

describe("detectBackfillRecordType", () => {
  test("returns 'message' for plain text", () => {
    const msg = _makeMockSupabaseMessage({ metadata: {} });
    expect(detectBackfillRecordType(msg)).toBe("message");
  });

  test("returns 'image_caption' for image_name metadata", () => {
    const msg = _makeMockSupabaseMessage({
      metadata: { image_name: "photo.jpg" },
    });
    expect(detectBackfillRecordType(msg)).toBe("image_caption");
  });

  test("returns 'image_caption' for image_mime metadata", () => {
    const msg = _makeMockSupabaseMessage({
      metadata: { image_mime: "image/jpeg" },
    });
    expect(detectBackfillRecordType(msg)).toBe("image_caption");
  });

  test("returns 'voice_transcript' for voice_transcript metadata", () => {
    const msg = _makeMockSupabaseMessage({
      metadata: { voice_transcript: true },
    });
    expect(detectBackfillRecordType(msg)).toBe("voice_transcript");
  });

  test("returns 'voice_transcript' for transcription metadata", () => {
    const msg = _makeMockSupabaseMessage({
      metadata: { transcription: "Some text" },
    });
    expect(detectBackfillRecordType(msg)).toBe("voice_transcript");
  });

  test("returns 'voice_transcript' for is_voice metadata", () => {
    const msg = _makeMockSupabaseMessage({
      metadata: { is_voice: true },
    });
    expect(detectBackfillRecordType(msg)).toBe("voice_transcript");
  });

  test("image takes priority over voice when both present", () => {
    const msg = _makeMockSupabaseMessage({
      metadata: { image_name: "photo.jpg", voice_transcript: true },
    });
    expect(detectBackfillRecordType(msg)).toBe("image_caption");
  });

  test("handles null metadata", () => {
    const msg = _makeMockSupabaseMessage({ metadata: null });
    expect(detectBackfillRecordType(msg)).toBe("message");
  });
});

// ── _makeMockSupabaseMessage ──────────────────────────────────

describe("_makeMockSupabaseMessage", () => {
  test("creates a valid default message", () => {
    const msg = _makeMockSupabaseMessage();
    expect(msg.id).toBeDefined();
    expect(msg.created_at).toBe("2026-03-10T12:00:00Z");
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("Test backfill message");
    expect(msg.channel).toBe("telegram");
    expect(msg.user_id).toBe("test-user");
  });

  test("accepts overrides", () => {
    const msg = _makeMockSupabaseMessage({
      id: "custom-id",
      role: "assistant",
      channel: "discord",
    });
    expect(msg.id).toBe("custom-id");
    expect(msg.role).toBe("assistant");
    expect(msg.channel).toBe("discord");
  });
});

// ── _makeMockFetcher ──────────────────────────────────────────

describe("_makeMockFetcher", () => {
  const messages: SupabaseMessage[] = [
    _makeMockSupabaseMessage({ id: "1", channel: "telegram", created_at: "2026-03-01T00:00:00Z" }),
    _makeMockSupabaseMessage({ id: "2", channel: "telegram", created_at: "2026-03-05T00:00:00Z" }),
    _makeMockSupabaseMessage({ id: "3", channel: "discord", created_at: "2026-03-08T00:00:00Z" }),
    _makeMockSupabaseMessage({ id: "4", channel: "telegram", created_at: "2026-03-10T00:00:00Z" }),
  ];

  test("returns all messages with no filters", async () => {
    const fetcher = _makeMockFetcher(messages);
    const { data, count } = await fetcher({ limit: 100, offset: 0 });
    expect(count).toBe(4);
    expect(data.length).toBe(4);
  });

  test("filters by channel", async () => {
    const fetcher = _makeMockFetcher(messages);
    const { data, count } = await fetcher({ channel: "telegram", limit: 100, offset: 0 });
    expect(count).toBe(3);
    expect(data.length).toBe(3);
    expect(data.every((m) => m.channel === "telegram")).toBe(true);
  });

  test("filters by since date", async () => {
    const fetcher = _makeMockFetcher(messages);
    const { data, count } = await fetcher({
      since: new Date("2026-03-05T00:00:00Z"),
      limit: 100,
      offset: 0,
    });
    expect(count).toBe(3);
    expect(data.length).toBe(3);
  });

  test("filters by until date", async () => {
    const fetcher = _makeMockFetcher(messages);
    const { data, count } = await fetcher({
      until: new Date("2026-03-05T00:00:00Z"),
      limit: 100,
      offset: 0,
    });
    expect(count).toBe(1);
    expect(data.length).toBe(1);
  });

  test("paginates with offset and limit", async () => {
    const fetcher = _makeMockFetcher(messages);
    const page1 = await fetcher({ limit: 2, offset: 0 });
    const page2 = await fetcher({ limit: 2, offset: 2 });
    expect(page1.data.length).toBe(2);
    expect(page2.data.length).toBe(2);
    expect(page1.data[0].id).toBe("1");
    expect(page2.data[0].id).toBe("3");
  });

  test("returns count only when limit is 0", async () => {
    const fetcher = _makeMockFetcher(messages);
    const { data, count } = await fetcher({ limit: 0, offset: 0 });
    expect(data.length).toBe(0);
    expect(count).toBe(4);
  });
});

// ── _makeMockWriter ───────────────────────────────────────────

describe("_makeMockWriter", () => {
  test("tracks written records", async () => {
    const { writer, written } = _makeMockWriter();
    const record = normalizeSupabaseMessage(_makeMockSupabaseMessage({ id: "msg-1" }));

    await writer(record);
    expect(written.length).toBe(1);
    expect(written[0].external_id).toBe("backfill:telegram:msg-1");
  });

  test("returns version 1 for new records", async () => {
    const { writer } = _makeMockWriter();
    const record = normalizeSupabaseMessage(_makeMockSupabaseMessage({ id: "msg-1" }));

    const result = await writer(record);
    expect(result.version).toBe(1);
  });

  test("returns version 2 for duplicate external_id", async () => {
    const { writer } = _makeMockWriter();
    const msg = _makeMockSupabaseMessage({ id: "msg-1" });
    const record = normalizeSupabaseMessage(msg);

    await writer(record);
    const result2 = await writer(record);
    expect(result2.version).toBe(2);
  });

  test("tracks seen external IDs", async () => {
    const { writer, seenExternalIds } = _makeMockWriter();
    const record = normalizeSupabaseMessage(_makeMockSupabaseMessage({ id: "msg-1" }));

    await writer(record);
    expect(seenExternalIds.has("backfill:telegram:msg-1")).toBe(true);
  });
});

// ── runBackfill ───────────────────────────────────────────────

describe("runBackfill", () => {
  test("imports all messages from fetcher", async () => {
    const messages = [
      _makeMockSupabaseMessage({ id: "1" }),
      _makeMockSupabaseMessage({ id: "2" }),
      _makeMockSupabaseMessage({ id: "3" }),
    ];
    const fetcher = _makeMockFetcher(messages);
    const { writer, written } = _makeMockWriter();

    const result = await runBackfill(fetcher, writer);

    expect(result.processed).toBe(3);
    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.errors.length).toBe(0);
    expect(result.pages).toBeGreaterThanOrEqual(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(written.length).toBe(3);
  });

  test("respects limit option", async () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      _makeMockSupabaseMessage({ id: `msg-${i}` }),
    );
    const fetcher = _makeMockFetcher(messages);
    const { writer, written } = _makeMockWriter();

    const result = await runBackfill(fetcher, writer, { limit: 5 });

    expect(result.processed).toBe(5);
    expect(written.length).toBe(5);
  });

  test("respects channel filter", async () => {
    const messages = [
      _makeMockSupabaseMessage({ id: "1", channel: "telegram" }),
      _makeMockSupabaseMessage({ id: "2", channel: "discord" }),
      _makeMockSupabaseMessage({ id: "3", channel: "telegram" }),
    ];
    const fetcher = _makeMockFetcher(messages);
    const { writer, written } = _makeMockWriter();

    const result = await runBackfill(fetcher, writer, { channel: "telegram" });

    expect(result.processed).toBe(2);
    expect(written.length).toBe(2);
    expect(written.every((r) => r.payload.channel === "telegram")).toBe(true);
  });

  test("respects since/until date filters", async () => {
    const messages = [
      _makeMockSupabaseMessage({ id: "1", created_at: "2026-01-01T00:00:00Z" }),
      _makeMockSupabaseMessage({ id: "2", created_at: "2026-02-15T00:00:00Z" }),
      _makeMockSupabaseMessage({ id: "3", created_at: "2026-03-10T00:00:00Z" }),
    ];
    const fetcher = _makeMockFetcher(messages);
    const { writer } = _makeMockWriter();

    const result = await runBackfill(fetcher, writer, {
      since: new Date("2026-02-01T00:00:00Z"),
      until: new Date("2026-03-01T00:00:00Z"),
    });

    expect(result.processed).toBe(1);
  });

  test("paginates through large datasets", async () => {
    const messages = Array.from({ length: 25 }, (_, i) =>
      _makeMockSupabaseMessage({ id: `msg-${i}` }),
    );
    const fetcher = _makeMockFetcher(messages);
    const { writer } = _makeMockWriter();

    const result = await runBackfill(fetcher, writer, { pageSize: 10 });

    expect(result.processed).toBe(25);
    expect(result.pages).toBe(3); // 10 + 10 + 5
  });

  test("reports progress via callback", async () => {
    const messages = Array.from({ length: 15 }, (_, i) =>
      _makeMockSupabaseMessage({ id: `msg-${i}` }),
    );
    const fetcher = _makeMockFetcher(messages);
    const { writer } = _makeMockWriter();
    const progressUpdates: BackfillProgress[] = [];

    await runBackfill(fetcher, writer, {
      pageSize: 5,
      onProgress: (p) => progressUpdates.push({ ...p }),
    });

    expect(progressUpdates.length).toBe(3); // 3 pages
    expect(progressUpdates[0].page).toBe(1);
    expect(progressUpdates[0].processed).toBe(5);
    expect(progressUpdates[2].page).toBe(3);
    expect(progressUpdates[2].processed).toBe(15);
    expect(progressUpdates[2].percent).toBe(100);
  });

  test("counts skipped (duplicate) records correctly", async () => {
    const msg = _makeMockSupabaseMessage({ id: "dup-1" });
    const messages = [msg, msg]; // same message twice
    const fetcher = _makeMockFetcher(messages);
    const { writer } = _makeMockWriter();

    const result = await runBackfill(fetcher, writer);

    expect(result.processed).toBe(2);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
  });

  test("handles writer errors gracefully", async () => {
    const messages = [
      _makeMockSupabaseMessage({ id: "ok-1" }),
      _makeMockSupabaseMessage({ id: "fail-1" }),
      _makeMockSupabaseMessage({ id: "ok-2" }),
    ];
    const fetcher = _makeMockFetcher(messages);

    let callCount = 0;
    const failingWriter = async (record: any) => {
      callCount++;
      if (callCount === 2) throw new Error("DB write failed");
      return { id: crypto.randomUUID(), version: 1 };
    };

    const result = await runBackfill(fetcher, failingWriter);

    expect(result.processed).toBe(3);
    expect(result.imported).toBe(2);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].messageId).toBe("fail-1");
    expect(result.errors[0].error).toBe("DB write failed");
  });

  test("handles empty dataset", async () => {
    const fetcher = _makeMockFetcher([]);
    const { writer } = _makeMockWriter();

    const result = await runBackfill(fetcher, writer);

    expect(result.processed).toBe(0);
    expect(result.imported).toBe(0);
    expect(result.pages).toBeLessThanOrEqual(1);
  });

  test("handles non-Error throws in writer", async () => {
    const messages = [_makeMockSupabaseMessage({ id: "msg-1" })];
    const fetcher = _makeMockFetcher(messages);

    const stringThrowWriter = async () => {
      throw "string error";
    };

    const result = await runBackfill(fetcher, stringThrowWriter);

    expect(result.errors.length).toBe(1);
    expect(result.errors[0].error).toBe("string error");
  });

  test("stops at limit even mid-page", async () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      _makeMockSupabaseMessage({ id: `msg-${i}` }),
    );
    const fetcher = _makeMockFetcher(messages);
    const { writer } = _makeMockWriter();

    const result = await runBackfill(fetcher, writer, { pageSize: 7, limit: 3 });

    expect(result.processed).toBe(3);
  });
});

// ── E2E ───────────────────────────────────────────────────────

describe("E2E: message backfill flow", () => {
  test("backfills mixed message types with channel filter and progress", async () => {
    const messages: SupabaseMessage[] = [
      _makeMockSupabaseMessage({
        id: "tg-1",
        channel: "telegram",
        content: "Hello from Telegram",
        created_at: "2026-03-01T10:00:00Z",
      }),
      _makeMockSupabaseMessage({
        id: "tg-2",
        channel: "telegram",
        content: "Voice memo",
        metadata: { voice_transcript: true },
        created_at: "2026-03-02T10:00:00Z",
      }),
      _makeMockSupabaseMessage({
        id: "dc-1",
        channel: "discord",
        content: "Hello from Discord",
        created_at: "2026-03-03T10:00:00Z",
      }),
      _makeMockSupabaseMessage({
        id: "tg-3",
        channel: "telegram",
        content: "Image message",
        metadata: { image_name: "photo.jpg", image_mime: "image/jpeg" },
        created_at: "2026-03-04T10:00:00Z",
      }),
    ];

    const fetcher = _makeMockFetcher(messages);
    const { writer, written } = _makeMockWriter();
    const progress: BackfillProgress[] = [];

    const result = await runBackfill(fetcher, writer, {
      channel: "telegram",
      pageSize: 2,
      onProgress: (p) => progress.push({ ...p }),
    });

    // Only telegram messages
    expect(result.processed).toBe(3);
    expect(result.imported).toBe(3);
    expect(result.errors.length).toBe(0);

    // Verify record types detected correctly
    const types = written.map((r) => r.record_type);
    expect(types).toContain("message");
    expect(types).toContain("voice_transcript");
    expect(types).toContain("image_caption");

    // Verify external IDs use backfill prefix
    expect(written.every((r) => r.external_id.startsWith("backfill:telegram:"))).toBe(true);

    // Verify all marked as backfilled
    expect(written.every((r) => r.payload.backfilled === true)).toBe(true);

    // Progress was reported
    expect(progress.length).toBe(2); // 2 pages (2 + 1)
    expect(progress[progress.length - 1].percent).toBe(100);
  });

  test("idempotent re-run does not create duplicates", async () => {
    const messages = [
      _makeMockSupabaseMessage({ id: "msg-1", content: "First" }),
      _makeMockSupabaseMessage({ id: "msg-2", content: "Second" }),
    ];
    const fetcher = _makeMockFetcher(messages);
    const { writer, written, seenExternalIds } = _makeMockWriter();

    // First run
    const run1 = await runBackfill(fetcher, writer);
    expect(run1.imported).toBe(2);
    expect(run1.skipped).toBe(0);

    // Second run — same messages, writer remembers external IDs
    const run2 = await runBackfill(fetcher, writer);
    expect(run2.imported).toBe(0);
    expect(run2.skipped).toBe(2);

    // Writer was called 4 times total but only 2 unique external IDs
    expect(written.length).toBe(4);
    expect(seenExternalIds.size).toBe(2);
  });
});
