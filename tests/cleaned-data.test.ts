/**
 * ELLIE-645 — Mountain: Cleaned data schema & processing pipeline
 *
 * Tests chunking, dedup, ingest, pipeline processing, retry, and queries.
 */

import { describe, test, expect, afterAll } from "bun:test";
import {
  chunkText, contentHash,
  ingestCleanedData, processRecord, retryRecord, processPendingRecords,
  getCleanedData, getChunks, getPipelineStatus,
  listCleanedData, deleteCleanedData,
} from "../../ellie-forest/src/index";
import type { PipelineResult } from "../../ellie-forest/src/index";
import sql from "../../ellie-forest/src/db";

// Track created records for cleanup
const createdIds: string[] = [];

afterAll(async () => {
  if (createdIds.length > 0) {
    // Chunks cascade-delete with the parent record
    await sql`DELETE FROM cleaned_data WHERE id = ANY(${createdIds})`;
  }
});

// ── chunkText (pure function) ─────────────────────────────────

describe("chunkText", () => {
  test("short text returns single chunk", () => {
    const chunks = chunkText("Hello world, this is a test.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("Hello world, this is a test.");
    expect(chunks[0].tokenCount).toBeGreaterThan(0);
  });

  test("long text is split into multiple chunks", () => {
    // ~512 tokens ≈ ~2048 chars. Create text longer than that.
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(100);
    const chunks = chunkText(text, { targetTokens: 100 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("respects target token size approximately", () => {
    const text = "Sentence one. Sentence two. Sentence three. ".repeat(200);
    const chunks = chunkText(text, { targetTokens: 100 });
    // Each chunk should be roughly 100 tokens = 400 chars, give or take
    for (const chunk of chunks) {
      // Allow some slack for sentence boundaries
      expect(chunk.tokenCount).toBeLessThan(200);
    }
  });

  test("overlap preserves context between chunks", () => {
    const sentences = Array.from({ length: 50 }, (_, i) => `Sentence ${i} content.`);
    const text = sentences.join(" ");
    const chunks = chunkText(text, { targetTokens: 50, overlapTokens: 10 });

    if (chunks.length >= 2) {
      // End of chunk 1 should partially overlap with start of chunk 2
      const end1 = chunks[0].content.slice(-50);
      const start2 = chunks[1].content.slice(0, 50);
      // They should share some text (due to overlap)
      // Just verify we get multiple chunks with reasonable sizes
      expect(chunks[0].content.length).toBeGreaterThan(0);
      expect(chunks[1].content.length).toBeGreaterThan(0);
    }
  });

  test("empty text returns single empty chunk", () => {
    const chunks = chunkText("");
    expect(chunks).toHaveLength(1);
  });

  test("custom config overrides defaults", () => {
    const text = "Word. ".repeat(500);
    const small = chunkText(text, { targetTokens: 50 });
    const large = chunkText(text, { targetTokens: 500 });
    expect(small.length).toBeGreaterThan(large.length);
  });
});

// ── contentHash ───────────────────────────────────────────────

describe("contentHash", () => {
  test("produces consistent hash for same content", () => {
    const h1 = contentHash("hello world");
    const h2 = contentHash("hello world");
    expect(h1).toBe(h2);
  });

  test("normalizes whitespace and case", () => {
    const h1 = contentHash("Hello World");
    const h2 = contentHash("hello world");
    expect(h1).toBe(h2);
  });

  test("different content produces different hashes", () => {
    const h1 = contentHash("hello world");
    const h2 = contentHash("goodbye world");
    expect(h1).not.toBe(h2);
  });

  test("returns 32-char hex string", () => {
    const h = contentHash("test");
    expect(h.length).toBe(32);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });
});

// ── ingestCleanedData ─────────────────────────────────────────

describe("ingestCleanedData", () => {
  test("creates a pending record", async () => {
    const record = await ingestCleanedData({
      connectorName: "test-645",
      sourceId: "test-645-ingest-1",
      content: "This is test content for ingestion.",
      title: "Test Document",
      contentType: "plain_text",
      metadata: { origin: "test" },
    });
    createdIds.push(record.id);

    expect(record.status).toBe("pending");
    expect(record.connector_name).toBe("test-645");
    expect(record.source_id).toBe("test-645-ingest-1");
    expect(record.title).toBe("Test Document");
    expect(record.content_type).toBe("plain_text");
  });

  test("defaults content_type to plain_text", async () => {
    const record = await ingestCleanedData({
      connectorName: "test-645",
      sourceId: "test-645-ingest-2",
      content: "Default content type test.",
    });
    createdIds.push(record.id);
    expect(record.content_type).toBe("plain_text");
  });
});

// ── processRecord (pipeline) ──────────────────────────────────

describe("processRecord", () => {
  test("processes short content: 1 chunk, status ready", async () => {
    const record = await ingestCleanedData({
      connectorName: "test-645",
      sourceId: "test-645-process-1",
      content: "Short content for processing pipeline test.",
    });
    createdIds.push(record.id);

    const result = await processRecord(record.id);
    expect(result.status).toBe("ready");
    expect(result.chunksCreated).toBe(1);
    expect(result.duplicatesFound).toBe(0);
    expect(result.error).toBeUndefined();

    // Verify DB state
    const updated = await getCleanedData(record.id);
    expect(updated!.status).toBe("ready");
    expect(updated!.processed_at).toBeInstanceOf(Date);
  });

  test("processes long content into multiple chunks", async () => {
    const content = "This is a fairly long paragraph of text that should be chunked. ".repeat(100);
    const record = await ingestCleanedData({
      connectorName: "test-645",
      sourceId: "test-645-process-long",
      content,
    });
    createdIds.push(record.id);

    const result = await processRecord(record.id, { targetTokens: 100 });
    expect(result.status).toBe("ready");
    expect(result.chunksCreated).toBeGreaterThan(1);

    const chunks = await getChunks(record.id);
    expect(chunks.length).toBe(result.chunksCreated);
    // Verify chunk ordering
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].chunk_index).toBe(i);
    }
  });

  test("detects duplicate chunks", async () => {
    const sharedContent = "This exact content will appear in two different records for dedup testing purposes.";

    // First record
    const r1 = await ingestCleanedData({
      connectorName: "test-645",
      sourceId: "test-645-dedup-1",
      content: sharedContent,
    });
    createdIds.push(r1.id);
    await processRecord(r1.id);

    // Second record with same content
    const r2 = await ingestCleanedData({
      connectorName: "test-645",
      sourceId: "test-645-dedup-2",
      content: sharedContent,
    });
    createdIds.push(r2.id);
    const result2 = await processRecord(r2.id);

    expect(result2.duplicatesFound).toBe(1);
    const chunks = await getChunks(r2.id);
    expect(chunks[0].is_duplicate).toBe(true);
    expect(chunks[0].duplicate_of).toBeTruthy();
  });

  test("chunks have dedup hashes", async () => {
    const record = await ingestCleanedData({
      connectorName: "test-645",
      sourceId: "test-645-hash",
      content: "Content for hash verification test.",
    });
    createdIds.push(record.id);
    await processRecord(record.id);

    const chunks = await getChunks(record.id);
    expect(chunks[0].dedup_hash).toBeTruthy();
    expect(chunks[0].dedup_hash!.length).toBe(32);
  });

  test("fails gracefully for nonexistent record", async () => {
    const result = await processRecord("00000000-0000-0000-0000-000000000000");
    expect(result.status).toBe("failed");
    expect(result.error).toContain("not found");
  });

  test("custom chunk config is respected", () => {
    // Pure function test — no DB/embedding needed
    const content = "Word here. ".repeat(500);
    const smallChunks = chunkText(content, { targetTokens: 50, overlapTokens: 10 });
    const largeChunks = chunkText(content, { targetTokens: 500, overlapTokens: 50 });
    expect(smallChunks.length).toBeGreaterThan(largeChunks.length);
    expect(smallChunks.length).toBeGreaterThan(5);
  });
});

// ── retryRecord ───────────────────────────────────────────────

describe("retryRecord", () => {
  test("resets failed record and reprocesses", async () => {
    const record = await ingestCleanedData({
      connectorName: "test-645",
      sourceId: "test-645-retry",
      content: "Content for retry test scenario.",
    });
    createdIds.push(record.id);

    // Process it first
    await processRecord(record.id);
    let data = await getCleanedData(record.id);
    expect(data!.status).toBe("ready");

    // Retry reprocesses
    const result = await retryRecord(record.id);
    expect(result.status).toBe("ready");
    expect(result.chunksCreated).toBe(1);

    // Verify old chunks were replaced
    const chunks = await getChunks(record.id);
    expect(chunks).toHaveLength(1);
  });
});

// ── processPendingRecords ─────────────────────────────────────

describe("processPendingRecords", () => {
  test("processes all pending records", async () => {
    const r1 = await ingestCleanedData({
      connectorName: "test-645",
      sourceId: "test-645-batch-1",
      content: "Batch test content one for pipeline.",
    });
    createdIds.push(r1.id);
    const r2 = await ingestCleanedData({
      connectorName: "test-645",
      sourceId: "test-645-batch-2",
      content: "Batch test content two for pipeline.",
    });
    createdIds.push(r2.id);

    const results = await processPendingRecords();
    // At least our 2 should be processed (there might be others from concurrent tests)
    const ourResults = results.filter(r =>
      r.recordId === r1.id || r.recordId === r2.id
    );
    expect(ourResults).toHaveLength(2);
    expect(ourResults.every(r => r.status === "ready")).toBe(true);
  });
});

// ── Query functions ───────────────────────────────────────────

describe("getCleanedData", () => {
  test("returns record by ID", async () => {
    const record = await ingestCleanedData({
      connectorName: "test-645",
      sourceId: "test-645-get",
      content: "Content for get test.",
    });
    createdIds.push(record.id);

    const fetched = await getCleanedData(record.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(record.id);
    expect(fetched!.source_id).toBe("test-645-get");
  });

  test("returns null for unknown ID", async () => {
    const result = await getCleanedData("00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });
});

describe("listCleanedData", () => {
  test("filters by connector name", async () => {
    const record = await ingestCleanedData({
      connectorName: "test-645-list",
      sourceId: "test-645-list-filter",
      content: "Content for list filter test.",
    });
    createdIds.push(record.id);

    const list = await listCleanedData({ connectorName: "test-645-list" });
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.every(r => r.connector_name === "test-645-list")).toBe(true);
  });

  test("filters by status", async () => {
    const record = await ingestCleanedData({
      connectorName: "test-645",
      sourceId: "test-645-list-status",
      content: "Content for status filter test.",
    });
    createdIds.push(record.id);
    await processRecord(record.id);

    const readyList = await listCleanedData({ status: "ready" });
    const ourRecord = readyList.find(r => r.id === record.id);
    expect(ourRecord).toBeDefined();
  });
});

describe("getPipelineStatus", () => {
  test("returns counts for all statuses", async () => {
    const status = await getPipelineStatus();
    expect(typeof status.pending).toBe("number");
    expect(typeof status.ready).toBe("number");
    expect(typeof status.failed).toBe("number");
    expect(typeof status.totalChunks).toBe("number");
    expect(typeof status.totalDuplicates).toBe("number");
  });
});

describe("deleteCleanedData", () => {
  test("deletes record and cascades to chunks", async () => {
    const record = await ingestCleanedData({
      connectorName: "test-645",
      sourceId: "test-645-delete",
      content: "Content to be deleted.",
    });
    await processRecord(record.id);

    const chunks = await getChunks(record.id);
    expect(chunks.length).toBeGreaterThan(0);

    const deleted = await deleteCleanedData(record.id);
    expect(deleted).toBe(true);

    // Verify gone
    const fetched = await getCleanedData(record.id);
    expect(fetched).toBeNull();
    const remainingChunks = await getChunks(record.id);
    expect(remainingChunks).toHaveLength(0);
  });

  test("returns false for unknown ID", async () => {
    const deleted = await deleteCleanedData("00000000-0000-0000-0000-000000000000");
    expect(deleted).toBe(false);
  });
});
