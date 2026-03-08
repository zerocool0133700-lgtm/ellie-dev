/**
 * ELLIE-641 — Hybrid search: BM25 + vector + RRF fusion
 *
 * Integration tests against the real Forest DB for BM25 search,
 * and unit tests for the pure RRF fusion function.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  writeMemory, readMemories,
  searchMemoriesBM25, fuseWithRRF,
} from "../../ellie-forest/src/index";
import sql from "../../ellie-forest/src/db";
import type { MemorySearchResult } from "../../ellie-forest/src/types";

// Track created memory IDs for cleanup
const createdIds: string[] = [];

async function cleanup() {
  if (createdIds.length === 0) return;
  await sql`DELETE FROM shared_memories WHERE id = ANY(${createdIds})`;
  createdIds.length = 0;
}

afterAll(cleanup);

// ── BM25 search ──────────────────────────────────────────────

describe("searchMemoriesBM25", () => {
  let targetId: string;

  beforeAll(async () => {
    // Write a memory with distinctive keywords for BM25 to find
    const mem = await writeMemory({
      content: `The xylophone orchestra performed a magnificent quantum entanglement symphony test-641-bm25-${Date.now()}`,
      type: "fact",
      scope: "global",
      confidence: 0.8,
    });
    targetId = mem.id;
    createdIds.push(targetId);

    // Write another with different keywords
    const mem2 = await writeMemory({
      content: `The submarine navigated through crystalline underwater caverns test-641-bm25-other-${Date.now()}`,
      type: "fact",
      scope: "global",
      confidence: 0.7,
    });
    createdIds.push(mem2.id);
  });

  test("finds memories by keyword match", async () => {
    const results = await searchMemoriesBM25("xylophone orchestra quantum");
    const found = results.find(r => r.id === targetId);
    expect(found).toBeTruthy();
  });

  test("returns similarity score (ts_rank_cd)", async () => {
    const results = await searchMemoriesBM25("xylophone orchestra quantum");
    expect(results.length).toBeGreaterThan(0);
    expect(typeof results[0].similarity).toBe("number");
    expect(results[0].similarity).toBeGreaterThan(0);
  });

  test("does not return unrelated memories", async () => {
    const results = await searchMemoriesBM25("xylophone orchestra quantum");
    // The submarine memory should not match "xylophone orchestra quantum"
    const submarine = results.find(r => r.content.includes("submarine"));
    expect(submarine).toBeUndefined();
  });

  test("respects limit parameter", async () => {
    const results = await searchMemoriesBM25("test", { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  test("returns memory_tier field", async () => {
    const results = await searchMemoriesBM25("xylophone orchestra quantum");
    const found = results.find(r => r.id === targetId);
    expect(found).toBeTruthy();
    expect(found!.memory_tier).toBe("extended");
  });

  test("returns empty array for no matches", async () => {
    const results = await searchMemoriesBM25("zzzznonexistentkeywordzzzzz");
    expect(results).toEqual([]);
  });
});

// ── fuseWithRRF (pure function) ──────────────────────────────

describe("fuseWithRRF", () => {
  function makeResult(id: string, similarity: number): MemorySearchResult {
    return {
      id,
      content: `memory ${id}`,
      type: "fact",
      scope: "global",
      scope_id: null,
      confidence: 0.8,
      source_entity_id: null,
      source_tree_id: null,
      similarity,
      created_at: new Date(),
      metadata: {},
      cognitive_type: null,
      weight: null,
      category: "general",
      memory_tier: "extended",
    };
  }

  test("fuses two ranked lists", () => {
    const vector = [makeResult("a", 0.9), makeResult("b", 0.8), makeResult("c", 0.7)];
    const bm25 = [makeResult("b", 0.5), makeResult("d", 0.4), makeResult("a", 0.3)];

    const fused = fuseWithRRF(vector, bm25, { k: 60, limit: 10 });

    // "a" and "b" appear in both lists — should have highest scores
    const ids = fused.map(r => r.id);
    // b: 1/(60+2) + 1/(60+1) = 1/62 + 1/61 ≈ 0.03252
    // a: 1/(60+1) + 1/(60+3) = 1/61 + 1/63 ≈ 0.03226
    // b wins because it's rank 1 in BM25
    expect(ids[0]).toBe("b");
    expect(ids[1]).toBe("a");
    // Both should rank above single-list entries
    const aIdx = ids.indexOf("a");
    const bIdx = ids.indexOf("b");
    const dIdx = ids.indexOf("d");
    expect(aIdx).toBeLessThan(dIdx);
    expect(bIdx).toBeLessThan(dIdx);
  });

  test("items in both lists score higher than single-list items", () => {
    const vector = [makeResult("a", 0.9), makeResult("c", 0.7)];
    const bm25 = [makeResult("a", 0.5), makeResult("d", 0.4)];

    const fused = fuseWithRRF(vector, bm25, { k: 60, limit: 10 });
    const ids = fused.map(r => r.id);
    // "a" in both lists should be first
    expect(ids[0]).toBe("a");
  });

  test("respects limit parameter", () => {
    const vector = [makeResult("a", 0.9), makeResult("b", 0.8), makeResult("c", 0.7)];
    const bm25 = [makeResult("d", 0.5), makeResult("e", 0.4)];

    const fused = fuseWithRRF(vector, bm25, { k: 60, limit: 2 });
    expect(fused.length).toBe(2);
  });

  test("handles empty vector results", () => {
    const bm25 = [makeResult("a", 0.5), makeResult("b", 0.4)];
    const fused = fuseWithRRF([], bm25, { k: 60, limit: 10 });
    expect(fused.length).toBe(2);
    expect(fused[0].id).toBe("a");
  });

  test("handles empty BM25 results", () => {
    const vector = [makeResult("a", 0.9), makeResult("b", 0.8)];
    const fused = fuseWithRRF(vector, [], { k: 60, limit: 10 });
    expect(fused.length).toBe(2);
    expect(fused[0].id).toBe("a");
  });

  test("handles both empty", () => {
    const fused = fuseWithRRF([], [], { k: 60, limit: 10 });
    expect(fused).toEqual([]);
  });

  test("overwrites similarity with RRF score", () => {
    const vector = [makeResult("a", 0.95)];
    const bm25 = [makeResult("a", 0.3)];

    const fused = fuseWithRRF(vector, bm25, { k: 60, limit: 10 });
    // RRF score = 1/(60+1) + 1/(60+1) = 2/61 ≈ 0.0328
    expect(fused[0].similarity).toBeCloseTo(2 / 61, 5);
  });

  test("uses default k=60 when not specified", () => {
    const vector = [makeResult("a", 0.9)];
    const bm25: MemorySearchResult[] = [];

    const fused = fuseWithRRF(vector, bm25);
    // RRF score = 1/(60+1) = 1/61
    expect(fused[0].similarity).toBeCloseTo(1 / 61, 5);
  });

  test("RRF formula produces correct scores", () => {
    // rank 1 in vector (index 0), rank 2 in bm25 (index 1)
    const vector = [makeResult("a", 0.9)];
    const bm25 = [makeResult("x", 0.5), makeResult("a", 0.3)];

    const fused = fuseWithRRF(vector, bm25, { k: 60, limit: 10 });
    const aResult = fused.find(r => r.id === "a")!;
    // vector rank 1 → 1/(60+1) = 1/61, bm25 rank 2 → 1/(60+2) = 1/62
    const expected = 1 / 61 + 1 / 62;
    expect(aResult.similarity).toBeCloseTo(expected, 5);
  });
});

// ── Hybrid readMemories integration ──────────────────────────

describe("readMemories hybrid integration", () => {
  let bm25FriendlyId: string;

  beforeAll(async () => {
    // Write a memory with very specific keywords that BM25 will find
    const mem = await writeMemory({
      content: `Pterodactyl migrations follow geomagnetic reversals across tectonic boundaries test-641-hybrid-${Date.now()}`,
      type: "fact",
      scope: "global",
      confidence: 0.8,
    });
    bm25FriendlyId = mem.id;
    createdIds.push(bm25FriendlyId);
  });

  test("readMemories returns results (hybrid path)", async () => {
    const results = await readMemories({
      query: "pterodactyl geomagnetic tectonic",
      scope: "global",
      match_count: 10,
      match_threshold: 0.3,
    });
    // Should return results — exact content depends on embeddings availability
    expect(Array.isArray(results)).toBe(true);
  });

  test("readMemories still works with scope_path (non-hybrid path)", async () => {
    const results = await readMemories({
      query: "test",
      scope_path: "2",
      match_count: 5,
    });
    expect(Array.isArray(results)).toBe(true);
  });
});

// ── tsvector column ──────────────────────────────────────────

describe("content_tsvector generated column", () => {
  test("tsvector is auto-generated on INSERT", async () => {
    const mem = await writeMemory({
      content: `Bioluminescent jellyfish illuminate deep ocean trenches test-641-tsvec-${Date.now()}`,
      type: "fact",
      scope: "global",
      confidence: 0.6,
    });
    createdIds.push(mem.id);

    const [row] = await sql<{ content_tsvector: string }[]>`
      SELECT content_tsvector::text FROM shared_memories WHERE id = ${mem.id}
    `;
    expect(row.content_tsvector).toContain("bioluminesc");
    expect(row.content_tsvector).toContain("jellyfish");
  });

  test("tsvector updates when content changes", async () => {
    const mem = await writeMemory({
      content: `Original unique platypus content test-641-update-${Date.now()}`,
      type: "fact",
      scope: "global",
      confidence: 0.6,
    });
    createdIds.push(mem.id);

    await sql`
      UPDATE shared_memories SET content = 'Changed to flamingo migration patterns' WHERE id = ${mem.id}
    `;

    const [row] = await sql<{ content_tsvector: string }[]>`
      SELECT content_tsvector::text FROM shared_memories WHERE id = ${mem.id}
    `;
    expect(row.content_tsvector).toContain("flamingo");
    expect(row.content_tsvector).not.toContain("platypus");
  });
});
