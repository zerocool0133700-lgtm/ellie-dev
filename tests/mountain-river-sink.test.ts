/**
 * Mountain River Sink Tests — ELLIE-661
 *
 * Tests pure mapping functions, deduplication, batch flush,
 * and end-to-end integration: message → mountain_records → River.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { sql } from "../../ellie-forest/src/index.ts";
import {
  RiverSink,
  mapRecordToDocument,
  buildDocumentPath,
  buildDocumentContent,
  buildFrontmatter,
  sanitizePathSegment,
  _makeMockRecord,
  type RawDocument,
} from "../src/mountain/river-sink.ts";
import type { MountainRecord } from "../src/mountain/records.ts";
import {
  ingestMessage,
  _resetIngestionForTesting,
  type IncomingMessage,
} from "../src/mountain/message-ingestion.ts";
import { getRecordByExternalId } from "../src/mountain/records.ts";

// ── Test Helpers ─────────────────────────────────────────────

const TEST_PREFIX = "test-river-";

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: `${TEST_PREFIX}${crypto.randomUUID()}`,
    role: "user",
    content: "River sink test message",
    channel: "telegram",
    metadata: {},
    userId: "test-user",
    timestamp: new Date("2026-03-10T12:00:00Z"),
    ...overrides,
  };
}

// Track fetch calls
interface FetchCall {
  url: string;
  body: Record<string, unknown>;
}

function makeMockFetch(responses: Array<{ ok: boolean; status: number; body?: string }> = []) {
  const calls: FetchCall[] = [];
  let callIdx = 0;

  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url: String(url), body });

    const resp = responses[callIdx] ?? { ok: true, status: 200, body: '{"success":true}' };
    callIdx++;

    return {
      ok: resp.ok,
      status: resp.status,
      text: async () => resp.body ?? "",
      json: async () => JSON.parse(resp.body ?? "{}"),
    } as Response;
  };

  return { fn, calls };
}

// ── Cleanup ──────────────────────────────────────────────────

async function cleanupTestRecords() {
  await sql`
    DELETE FROM mountain_records
    WHERE source_system = 'relay'
      AND external_id LIKE ${"relay:%:" + TEST_PREFIX + "%"}
  `;
}

beforeEach(() => {
  _resetIngestionForTesting();
});

afterAll(async () => {
  await cleanupTestRecords();
});

// ── sanitizePathSegment ──────────────────────────────────────

describe("sanitizePathSegment", () => {
  test("lowercases and replaces special chars", () => {
    expect(sanitizePathSegment("Hello World!")).toBe("hello-world");
  });

  test("replaces colons and slashes", () => {
    expect(sanitizePathSegment("relay:telegram:abc-123")).toBe("relay-telegram-abc-123");
  });

  test("collapses multiple dashes", () => {
    expect(sanitizePathSegment("a::b//c")).toBe("a-b-c");
  });

  test("trims leading/trailing dashes", () => {
    expect(sanitizePathSegment("!hello!")).toBe("hello");
  });

  test("handles empty string", () => {
    expect(sanitizePathSegment("")).toBe("");
  });
});

// ── buildDocumentPath ────────────────────────────────────────

describe("buildDocumentPath", () => {
  test("builds path from record", () => {
    const record = _makeMockRecord({
      source_system: "relay",
      record_type: "message",
      external_id: "relay:telegram:msg-42",
      source_timestamp: new Date("2026-03-10T12:00:00Z"),
    });

    const path = buildDocumentPath(record);
    expect(path).toBe("mountain/relay/message/2026-03-10/relay-telegram-msg-42.md");
  });

  test("uses created_at when source_timestamp is null", () => {
    const record = _makeMockRecord({
      source_timestamp: null,
      created_at: new Date("2026-01-15T08:00:00Z"),
    });

    const path = buildDocumentPath(record);
    expect(path).toContain("2026-01-15");
  });

  test("truncates long external IDs to 80 chars", () => {
    const longId = "relay:telegram:" + "a".repeat(200);
    const record = _makeMockRecord({ external_id: longId });

    const path = buildDocumentPath(record);
    const segments = path.split("/");
    const filename = segments[segments.length - 1];
    // filename = slug.md, slug is max 80 chars
    expect(filename.replace(".md", "").length).toBeLessThanOrEqual(80);
  });
});

// ── buildFrontmatter ─────────────────────────────────────────

describe("buildFrontmatter", () => {
  test("includes all required fields", () => {
    const record = _makeMockRecord();
    const fm = buildFrontmatter(record);

    expect(fm.mountain_record_id).toBe(record.id);
    expect(fm.source_system).toBe("relay");
    expect(fm.external_id).toBe(record.external_id);
    expect(fm.record_type).toBe("message");
    expect(fm.version).toBe(1);
    expect(fm.status).toBe("active");
  });

  test("handles null source_timestamp", () => {
    const record = _makeMockRecord({ source_timestamp: null });
    const fm = buildFrontmatter(record);
    expect(fm.source_timestamp).toBeNull();
  });

  test("includes harvest_job_id when present", () => {
    const record = _makeMockRecord({ harvest_job_id: "job-123" });
    const fm = buildFrontmatter(record);
    expect(fm.harvest_job_id).toBe("job-123");
  });
});

// ── buildDocumentContent ─────────────────────────────────────

describe("buildDocumentContent", () => {
  test("builds markdown from payload content", () => {
    const record = _makeMockRecord({
      payload: { content: "Hello world", channel: "telegram", role: "user" },
      summary: "Hello world",
    });
    const content = buildDocumentContent(record);

    expect(content).toContain("# Hello world");
    expect(content).toContain("## Content");
    expect(content).toContain("Hello world");
  });

  test("includes metadata section for non-content keys", () => {
    const record = _makeMockRecord({
      payload: { content: "Hi", channel: "telegram", sender: "dave" },
    });
    const content = buildDocumentContent(record);

    expect(content).toContain("## Metadata");
    expect(content).toContain("**channel**: telegram");
    expect(content).toContain("**sender**: dave");
  });

  test("includes role as blockquote", () => {
    const record = _makeMockRecord({
      payload: { content: "Hi", role: "assistant" },
    });
    const content = buildDocumentContent(record);
    expect(content).toContain("> Role: assistant");
  });

  test("falls back to external_id for title", () => {
    const record = _makeMockRecord({
      summary: null,
      payload: {},
    });
    const content = buildDocumentContent(record);
    expect(content).toContain(`# ${record.external_id}`);
  });

  test("handles nested object metadata", () => {
    const record = _makeMockRecord({
      payload: { content: "Hi", context: { user_id: "abc", nested: true } },
    });
    const content = buildDocumentContent(record);
    expect(content).toContain("**context**:");
    expect(content).toContain('"user_id"');
  });
});

// ── mapRecordToDocument ──────────────────────────────────────

describe("mapRecordToDocument", () => {
  test("returns a complete RawDocument", () => {
    const record = _makeMockRecord();
    const doc = mapRecordToDocument(record);

    expect(doc.path).toContain("mountain/relay/message/");
    expect(doc.path).toEndWith(".md");
    expect(doc.content).toContain("# ");
    expect(doc.frontmatter.mountain_record_id).toBe(record.id);
    expect(doc.mountainRecordId).toBe(record.id);
    expect(doc.externalId).toBe(record.external_id);
    expect(doc.version).toBe(record.version);
  });
});

// ── RiverSink deduplication ──────────────────────────────────

describe("RiverSink deduplication", () => {
  test("enqueues new records", () => {
    const sink = new RiverSink({ fetchFn: makeMockFetch().fn });
    const record = _makeMockRecord();
    const doc = sink.enqueue(record);

    expect(doc).not.toBeNull();
    expect(sink.queueSize).toBe(1);
  });

  test("skips already-processed versions", async () => {
    const { fn } = makeMockFetch([{ ok: true, status: 200 }]);
    const sink = new RiverSink({ fetchFn: fn });

    const record = _makeMockRecord({ version: 1 });
    sink.enqueue(record);
    await sink.flush();

    // Same record, same version → skip
    const doc = sink.enqueue(record);
    expect(doc).toBeNull();
    expect(sink.queueSize).toBe(0);
  });

  test("accepts newer versions of same record", async () => {
    const { fn } = makeMockFetch([{ ok: true, status: 200 }]);
    const sink = new RiverSink({ fetchFn: fn });

    const record = _makeMockRecord({ version: 1 });
    sink.enqueue(record);
    await sink.flush();

    const updated = { ...record, version: 2 };
    const doc = sink.enqueue(updated);
    expect(doc).not.toBeNull();
    expect(sink.queueSize).toBe(1);
  });

  test("clearDedupCache resets version tracking", async () => {
    const { fn } = makeMockFetch([{ ok: true, status: 200 }]);
    const sink = new RiverSink({ fetchFn: fn });

    const record = _makeMockRecord({ version: 1 });
    sink.enqueue(record);
    await sink.flush();

    sink.clearDedupCache();

    // Same version now accepted again
    const doc = sink.enqueue(record);
    expect(doc).not.toBeNull();
  });

  test("clearQueue empties pending documents", () => {
    const sink = new RiverSink({ fetchFn: makeMockFetch().fn });
    sink.enqueue(_makeMockRecord());
    sink.enqueue(_makeMockRecord());
    expect(sink.queueSize).toBe(2);

    sink.clearQueue();
    expect(sink.queueSize).toBe(0);
  });
});

// ── RiverSink flush ──────────────────────────────────────────

describe("RiverSink flush", () => {
  test("writes queued documents via Bridge API", async () => {
    const { fn, calls } = makeMockFetch([
      { ok: true, status: 200 },
    ]);
    const sink = new RiverSink({ fetchFn: fn, baseUrl: "http://test:3001" });

    sink.enqueue(_makeMockRecord());
    const result = await sink.flush();

    expect(result.written).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://test:3001/api/bridge/river/write");
    expect(calls[0].body.operation).toBe("update");
  });

  test("batch writes multiple documents", async () => {
    const { fn, calls } = makeMockFetch([
      { ok: true, status: 200 },
      { ok: true, status: 200 },
      { ok: true, status: 200 },
    ]);
    const sink = new RiverSink({ fetchFn: fn });

    sink.enqueue(_makeMockRecord());
    sink.enqueue(_makeMockRecord());
    sink.enqueue(_makeMockRecord());

    const result = await sink.flush();
    expect(result.written).toBe(3);
    expect(calls).toHaveLength(3);
  });

  test("falls back to create when update returns 404", async () => {
    const { fn, calls } = makeMockFetch([
      { ok: false, status: 404, body: "not found" },
      { ok: true, status: 200 },
    ]);
    const sink = new RiverSink({ fetchFn: fn });

    sink.enqueue(_makeMockRecord());
    const result = await sink.flush();

    expect(result.written).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[0].body.operation).toBe("update");
    expect(calls[1].body.operation).toBe("create");
  });

  test("records error when both update and create fail", async () => {
    const { fn } = makeMockFetch([
      { ok: false, status: 404, body: "not found" },
      { ok: false, status: 500, body: "server error" },
    ]);
    const sink = new RiverSink({ fetchFn: fn });

    sink.enqueue(_makeMockRecord());
    const result = await sink.flush();

    expect(result.written).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain("500");
  });

  test("records error on non-404 failure", async () => {
    const { fn } = makeMockFetch([
      { ok: false, status: 500, body: "internal error" },
    ]);
    const sink = new RiverSink({ fetchFn: fn });

    sink.enqueue(_makeMockRecord());
    const result = await sink.flush();

    expect(result.written).toBe(0);
    expect(result.errors).toHaveLength(1);
  });

  test("empty flush returns immediately", async () => {
    const { fn, calls } = makeMockFetch();
    const sink = new RiverSink({ fetchFn: fn });

    const result = await sink.flush();
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("queue is cleared after flush", async () => {
    const { fn } = makeMockFetch([{ ok: true, status: 200 }]);
    const sink = new RiverSink({ fetchFn: fn });

    sink.enqueue(_makeMockRecord());
    await sink.flush();

    expect(sink.queueSize).toBe(0);
  });

  test("durationMs is reported", async () => {
    const { fn } = makeMockFetch([{ ok: true, status: 200 }]);
    const sink = new RiverSink({ fetchFn: fn });

    sink.enqueue(_makeMockRecord());
    const result = await sink.flush();

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("document content includes frontmatter YAML", async () => {
    const { fn, calls } = makeMockFetch([{ ok: true, status: 200 }]);
    const sink = new RiverSink({ fetchFn: fn });

    sink.enqueue(_makeMockRecord({ source_system: "relay", record_type: "message" }));
    await sink.flush();

    const content = calls[0].body.content as string;
    expect(content).toContain("---");
    expect(content).toContain("source_system:");
    expect(content).toContain("record_type:");
    expect(content).toContain("mountain_record_id:");
  });

  test("continues processing after individual write failure", async () => {
    const { fn } = makeMockFetch([
      { ok: false, status: 500, body: "error" },
      { ok: true, status: 200 },
    ]);
    const sink = new RiverSink({ fetchFn: fn });

    sink.enqueue(_makeMockRecord());
    sink.enqueue(_makeMockRecord());

    const result = await sink.flush();
    expect(result.written).toBe(1);
    expect(result.errors).toHaveLength(1);
  });
});

// ── Integration: ingest → mountain_records → RiverSink ──────

describe("end-to-end: message → mountain → river", () => {
  beforeEach(async () => {
    await cleanupTestRecords();
  });

  test("ingested message can be mapped and enqueued to River", async () => {
    const msg = makeMsg({ content: "E2E test message" });
    const recordId = await ingestMessage(msg);
    expect(recordId).not.toBeNull();

    // Fetch the record from mountain_records
    const externalId = `relay:telegram:${msg.id}`;
    const record = await getRecordByExternalId("relay", externalId);
    expect(record).not.toBeNull();

    // Map and enqueue
    const { fn, calls } = makeMockFetch([{ ok: true, status: 200 }]);
    const sink = new RiverSink({ fetchFn: fn });
    const doc = sink.enqueue(record!);

    expect(doc).not.toBeNull();
    expect(doc!.path).toContain("mountain/relay/message/2026-03-10/");
    expect(doc!.content).toContain("E2E test message");

    // Flush to River
    const result = await sink.flush();
    expect(result.written).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test("dedup prevents re-processing same version", async () => {
    const msg = makeMsg();
    await ingestMessage(msg);

    const externalId = `relay:telegram:${msg.id}`;
    const record = await getRecordByExternalId("relay", externalId);

    const { fn } = makeMockFetch([{ ok: true, status: 200 }]);
    const sink = new RiverSink({ fetchFn: fn });

    // First time: enqueue succeeds
    expect(sink.enqueue(record!)).not.toBeNull();
    await sink.flush();

    // Second time with same version: skip
    expect(sink.enqueue(record!)).toBeNull();
  });

  test("updated record (version bump) passes dedup", async () => {
    const msg = makeMsg();
    await ingestMessage(msg);

    const externalId = `relay:telegram:${msg.id}`;
    const v1 = await getRecordByExternalId("relay", externalId);

    const { fn } = makeMockFetch([
      { ok: true, status: 200 },
      { ok: true, status: 200 },
    ]);
    const sink = new RiverSink({ fetchFn: fn });

    sink.enqueue(v1!);
    await sink.flush();

    // Re-ingest to bump version
    msg.content = "Updated message";
    await ingestMessage(msg);
    const v2 = await getRecordByExternalId("relay", externalId);
    expect(v2!.version).toBe(2);

    // Version 2 should pass dedup
    expect(sink.enqueue(v2!)).not.toBeNull();
    const result = await sink.flush();
    expect(result.written).toBe(1);
  });

  test("voice transcript maps correctly", async () => {
    const msg = makeMsg({
      content: "Transcribed speech",
      metadata: { voice_transcript: true },
    });
    await ingestMessage(msg);

    const externalId = `relay:telegram:${msg.id}`;
    const record = await getRecordByExternalId("relay", externalId);
    const doc = mapRecordToDocument(record!);

    expect(doc.path).toContain("voice_transcript");
    expect(doc.frontmatter.record_type).toBe("voice_transcript");
  });

  test("image caption maps correctly", async () => {
    const msg = makeMsg({
      content: "Photo description",
      metadata: { image_name: "photo.jpg", image_mime: "image/jpeg" },
    });
    await ingestMessage(msg);

    const externalId = `relay:telegram:${msg.id}`;
    const record = await getRecordByExternalId("relay", externalId);
    const doc = mapRecordToDocument(record!);

    expect(doc.path).toContain("image_caption");
    expect(doc.frontmatter.record_type).toBe("image_caption");
  });
});
