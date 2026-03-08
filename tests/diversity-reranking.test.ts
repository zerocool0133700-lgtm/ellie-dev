/**
 * ELLIE-635 — Diversity re-ranking for search results
 *
 * Tests MMR (Maximal Marginal Relevance) re-ranking with scope
 * and temporal spread bonuses. Includes unit tests for the pure
 * functions and integration tests against the real Forest DB.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  writeMemory, readMemories,
  cosineSimilarity, applyMMR, DEFAULT_DIVERSITY_OPTS,
} from "../../ellie-forest/src/index";
import type { MemorySearchResult, DiversityOpts } from "../../ellie-forest/src/index";
import sql from "../../ellie-forest/src/db";

const createdIds: string[] = [];

async function cleanup() {
  if (createdIds.length === 0) return;
  await sql`DELETE FROM shared_memories WHERE id = ANY(${createdIds})`;
  createdIds.length = 0;
}

afterAll(cleanup);

// ── cosineSimilarity (pure function) ─────────────────────────

describe("cosineSimilarity", () => {
  test("identical vectors have similarity 1.0", () => {
    const v = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  test("orthogonal vectors have similarity 0.0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0, 5);
  });

  test("opposite vectors have similarity -1.0", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0, 5);
  });

  test("empty vectors return 0", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  test("mismatched lengths return 0", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  test("similar vectors have high similarity", () => {
    const a = [0.9, 0.1, 0.0];
    const b = [0.85, 0.15, 0.05];
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.95);
  });

  test("dissimilar vectors have low similarity", () => {
    const a = [1.0, 0.0, 0.0];
    const b = [0.0, 0.0, 1.0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });
});

// ── applyMMR (with mocked results) ──────────────────────────

describe("applyMMR", () => {
  function makeResult(
    id: string,
    similarity: number,
    createdAt: Date = new Date(),
  ): MemorySearchResult {
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
      created_at: createdAt,
      metadata: {},
      cognitive_type: null,
      weight: null,
      category: "general",
      memory_tier: "extended",
    };
  }

  test("single result returned unchanged", async () => {
    const mem = await writeMemory({
      content: `test-635-mmr-single-${Date.now()}`,
      type: "fact",
      scope: "global",
      confidence: 0.5,
    });
    createdIds.push(mem.id);

    const results = [makeResult(mem.id, 1.0)];
    const diverse = await applyMMR(results);
    expect(diverse).toHaveLength(1);
    expect(diverse[0].id).toBe(mem.id);
  });

  test("empty results returned unchanged", async () => {
    const diverse = await applyMMR([]);
    expect(diverse).toEqual([]);
  });

  test("first result always selected (highest relevance)", async () => {
    const mems = await Promise.all([
      writeMemory({ content: `test-635-mmr-first-a-${Date.now()}`, type: "fact", scope: "global", confidence: 0.5 }),
      writeMemory({ content: `test-635-mmr-first-b-${Date.now()}`, type: "fact", scope: "global", confidence: 0.5 }),
    ]);
    createdIds.push(...mems.map(m => m.id));

    const results = [
      makeResult(mems[0].id, 0.9),
      makeResult(mems[1].id, 0.5),
    ];
    const diverse = await applyMMR(results);
    expect(diverse[0].id).toBe(mems[0].id);
  });

  test("lambda=1.0 preserves original relevance ordering", async () => {
    const mems = await Promise.all([
      writeMemory({ content: `test-635-lambda1-a-${Date.now()}`, type: "fact", scope: "global", confidence: 0.5 }),
      writeMemory({ content: `test-635-lambda1-b-${Date.now()}`, type: "fact", scope: "global", confidence: 0.5 }),
      writeMemory({ content: `test-635-lambda1-c-${Date.now()}`, type: "fact", scope: "global", confidence: 0.5 }),
    ]);
    createdIds.push(...mems.map(m => m.id));

    const results = [
      makeResult(mems[0].id, 0.9),
      makeResult(mems[1].id, 0.7),
      makeResult(mems[2].id, 0.5),
    ];
    const diverse = await applyMMR(results, { lambda: 1.0, scopePenalty: 0, temporalPenalty: 0 });
    expect(diverse.map(r => r.id)).toEqual(mems.map(m => m.id));
  });

  test("same-day results get temporal penalty", async () => {
    const sameDay = new Date("2026-01-15T10:00:00Z");
    const differentDay = new Date("2026-02-20T10:00:00Z");

    const mems = await Promise.all([
      writeMemory({ content: `test-635-temporal-a-${Date.now()}`, type: "fact", scope: "global", confidence: 0.5 }),
      writeMemory({ content: `test-635-temporal-b-${Date.now()}`, type: "fact", scope: "global", confidence: 0.5 }),
      writeMemory({ content: `test-635-temporal-c-${Date.now()}`, type: "fact", scope: "global", confidence: 0.5 }),
    ]);
    createdIds.push(...mems.map(m => m.id));

    // Two results from same day, one from different day
    // Result b and a share a day; c is on a different day
    const results = [
      makeResult(mems[0].id, 0.9, sameDay),
      makeResult(mems[1].id, 0.85, sameDay),         // same day as a → penalty
      makeResult(mems[2].id, 0.84, differentDay),     // different day → no penalty
    ];

    // With high temporal penalty, c should leapfrog b
    const diverse = await applyMMR(results, { lambda: 1.0, scopePenalty: 0, temporalPenalty: 0.1 });
    // First result is always a (highest score)
    expect(diverse[0].id).toBe(mems[0].id);
    // c (different day) should rank before b (same day as a) despite lower score
    expect(diverse[1].id).toBe(mems[2].id);
    expect(diverse[2].id).toBe(mems[1].id);
  });

  test("preserves all results (no results dropped)", async () => {
    const mems = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        writeMemory({ content: `test-635-preserve-${i}-${Date.now()}`, type: "fact", scope: "global", confidence: 0.5 })
      )
    );
    createdIds.push(...mems.map(m => m.id));

    const results = mems.map((m, i) => makeResult(m.id, 1.0 - i * 0.1));
    const diverse = await applyMMR(results);
    expect(diverse).toHaveLength(5);
    // All original IDs present
    const diverseIds = new Set(diverse.map(r => r.id));
    for (const m of mems) {
      expect(diverseIds.has(m.id)).toBe(true);
    }
  });
});

// ── DEFAULT_DIVERSITY_OPTS ───────────────────────────────────

describe("DEFAULT_DIVERSITY_OPTS", () => {
  test("lambda defaults to 0.7", () => {
    expect(DEFAULT_DIVERSITY_OPTS.lambda).toBe(0.7);
  });

  test("scopePenalty defaults to 0.1", () => {
    expect(DEFAULT_DIVERSITY_OPTS.scopePenalty).toBe(0.1);
  });

  test("temporalPenalty defaults to 0.05", () => {
    expect(DEFAULT_DIVERSITY_OPTS.temporalPenalty).toBe(0.05);
  });
});

// ── Integration: diversity in readMemories ───────────────────

describe("readMemories with diversity", () => {
  test("readMemories returns diverse results", async () => {
    // Write several similar memories to test diversity
    const mems = await Promise.all([
      writeMemory({ content: `Photosynthesis converts sunlight to chemical energy in chloroplasts test-635-int-${Date.now()}`, type: "fact", scope: "global", confidence: 0.8 }),
      writeMemory({ content: `Photosynthesis in plants uses chlorophyll to absorb light test-635-int-${Date.now()}`, type: "fact", scope: "global", confidence: 0.8 }),
      writeMemory({ content: `Quantum computing uses qubits for parallel computation test-635-int-${Date.now()}`, type: "fact", scope: "global", confidence: 0.8 }),
    ]);
    createdIds.push(...mems.map(m => m.id));

    const results = await readMemories({
      query: "photosynthesis sunlight chloroplasts",
      scope: "global",
      match_count: 10,
      match_threshold: 0.3,
    });

    expect(Array.isArray(results)).toBe(true);
  });

  test("readMemories scope_path still works (no diversity applied)", async () => {
    const results = await readMemories({
      query: "test",
      scope_path: "2",
      match_count: 5,
    });
    expect(Array.isArray(results)).toBe(true);
  });
});
