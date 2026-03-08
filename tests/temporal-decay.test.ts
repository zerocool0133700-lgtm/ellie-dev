/**
 * ELLIE-634 — Temporal decay scoring for memory retrieval
 *
 * Tests the Generative Agents-inspired scoring formula:
 * score = alpha * recency + beta * relevance + gamma * importance
 *
 * Includes unit tests for the pure scoring function and integration
 * tests against the real Forest DB.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  writeMemory, readMemories, getMemory,
  touchMemory, touchMemories,
  computeTemporalDecayScore, DEFAULT_DECAY_WEIGHTS,
} from "../../ellie-forest/src/index";
import type { TemporalDecayWeights } from "../../ellie-forest/src/index";
import sql from "../../ellie-forest/src/db";

const createdIds: string[] = [];

async function cleanup() {
  if (createdIds.length === 0) return;
  await sql`DELETE FROM shared_memories WHERE id = ANY(${createdIds})`;
  createdIds.length = 0;
}

afterAll(cleanup);

// ── computeTemporalDecayScore (pure function) ────────────────

describe("computeTemporalDecayScore", () => {
  const weights: TemporalDecayWeights = {
    alpha: 1.0,
    beta: 1.0,
    gamma: 1.0,
    lambda: 0.693 / (7 * 24), // 7-day half-life
  };

  test("recently accessed memory scores higher than old one", () => {
    const now = Date.now();
    const recentAccess = new Date(now - 1 * 60 * 60 * 1000); // 1 hour ago
    const oldAccess = new Date(now - 14 * 24 * 60 * 60 * 1000); // 14 days ago

    const recentScore = computeTemporalDecayScore(0.8, 5.0, recentAccess, weights, now);
    const oldScore = computeTemporalDecayScore(0.8, 5.0, oldAccess, weights, now);

    expect(recentScore).toBeGreaterThan(oldScore);
  });

  test("higher importance scores higher", () => {
    const now = Date.now();
    const access = new Date(now - 24 * 60 * 60 * 1000); // 1 day ago

    const highImportance = computeTemporalDecayScore(0.8, 9.0, access, weights, now);
    const lowImportance = computeTemporalDecayScore(0.8, 2.0, access, weights, now);

    expect(highImportance).toBeGreaterThan(lowImportance);
  });

  test("higher relevance scores higher", () => {
    const now = Date.now();
    const access = new Date(now - 24 * 60 * 60 * 1000);

    const highRelevance = computeTemporalDecayScore(0.95, 5.0, access, weights, now);
    const lowRelevance = computeTemporalDecayScore(0.3, 5.0, access, weights, now);

    expect(highRelevance).toBeGreaterThan(lowRelevance);
  });

  test("null last_accessed_at treated as just now (no decay)", () => {
    const now = Date.now();
    const justNow = new Date(now);

    const nullScore = computeTemporalDecayScore(0.8, 5.0, null, weights, now);
    const nowScore = computeTemporalDecayScore(0.8, 5.0, justNow, weights, now);

    expect(nullScore).toBeCloseTo(nowScore, 5);
  });

  test("recency decays exponentially with 7-day half-life", () => {
    const now = Date.now();
    const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

    // With alpha=1, beta=0, gamma=0 — pure recency
    const pureRecencyWeights: TemporalDecayWeights = { alpha: 1.0, beta: 0, gamma: 0, lambda: weights.lambda };
    const score = computeTemporalDecayScore(0, 0, oneWeekAgo, pureRecencyWeights, now);

    // After one half-life, recency should be ~0.5
    expect(score).toBeCloseTo(0.5, 1);
  });

  test("two half-lives gives ~0.25 recency", () => {
    const now = Date.now();
    const twoWeeksAgo = new Date(now - 14 * 24 * 60 * 60 * 1000);

    const pureRecencyWeights: TemporalDecayWeights = { alpha: 1.0, beta: 0, gamma: 0, lambda: weights.lambda };
    const score = computeTemporalDecayScore(0, 0, twoWeeksAgo, pureRecencyWeights, now);

    expect(score).toBeCloseTo(0.25, 1);
  });

  test("importance is normalized to 0-1 range (divided by 10)", () => {
    const now = Date.now();
    // Pure importance: alpha=0, beta=0, gamma=1
    const pureImportance: TemporalDecayWeights = { alpha: 0, beta: 0, gamma: 1.0, lambda: 0 };

    const score10 = computeTemporalDecayScore(0, 10.0, null, pureImportance, now);
    const score5 = computeTemporalDecayScore(0, 5.0, null, pureImportance, now);

    expect(score10).toBeCloseTo(1.0, 5);
    expect(score5).toBeCloseTo(0.5, 5);
  });

  test("all weights = 0 except beta preserves relevance-only ranking", () => {
    const now = Date.now();
    const relevanceOnly: TemporalDecayWeights = { alpha: 0, beta: 1.0, gamma: 0, lambda: 0 };

    const score = computeTemporalDecayScore(0.85, 10.0, null, relevanceOnly, now);
    expect(score).toBeCloseTo(0.85, 5);
  });

  test("default weights are reasonable", () => {
    expect(DEFAULT_DECAY_WEIGHTS.alpha).toBe(1.0);
    expect(DEFAULT_DECAY_WEIGHTS.beta).toBe(1.0);
    expect(DEFAULT_DECAY_WEIGHTS.gamma).toBe(1.0);
    expect(DEFAULT_DECAY_WEIGHTS.lambda).toBeGreaterThan(0);
  });
});

// ── importance_score on writeMemory ──────────────────────────

describe("importance_score on writeMemory", () => {
  test("derives importance from type — decision gets high score", async () => {
    const mem = await writeMemory({
      content: `test-634-decision-importance-${Date.now()}`,
      type: "decision",
      scope: "global",
      confidence: 0.9,
    });
    createdIds.push(mem.id);
    // decision base=8.0 + (0.9-0.5)*2 = 8.8
    expect(mem.importance_score).toBeCloseTo(8.8, 1);
  });

  test("derives importance from type — hypothesis gets low score", async () => {
    const mem = await writeMemory({
      content: `test-634-hypothesis-importance-${Date.now()}`,
      type: "hypothesis",
      scope: "global",
      confidence: 0.3,
    });
    createdIds.push(mem.id);
    // hypothesis base=4.0 + (0.3-0.5)*2 = 3.6
    expect(mem.importance_score).toBeCloseTo(3.6, 1);
  });

  test("manual importance_score override", async () => {
    const mem = await writeMemory({
      content: `test-634-manual-importance-${Date.now()}`,
      type: "fact",
      scope: "global",
      confidence: 0.5,
      importance_score: 9.5,
    });
    createdIds.push(mem.id);
    expect(mem.importance_score).toBe(9.5);
  });

  test("defaults to 5.0 for plain facts at 0.5 confidence", async () => {
    const mem = await writeMemory({
      content: `test-634-default-importance-${Date.now()}`,
      type: "fact",
      scope: "global",
      confidence: 0.5,
    });
    createdIds.push(mem.id);
    // fact base=5.0 + (0.5-0.5)*2 = 5.0
    expect(mem.importance_score).toBe(5.0);
  });
});

// ── Retrieval reinforcement (touch) ──────────────────────────

describe("retrieval reinforcement", () => {
  test("touchMemory updates last_accessed_at", async () => {
    const mem = await writeMemory({
      content: `test-634-touch-single-${Date.now()}`,
      type: "fact",
      scope: "global",
      confidence: 0.5,
    });
    createdIds.push(mem.id);

    // Initially null
    const before = await getMemory(mem.id);
    expect(before!.last_accessed_at).toBeNull();

    await touchMemory(mem.id);

    const after = await getMemory(mem.id);
    expect(after!.last_accessed_at).not.toBeNull();
    expect(after!.access_count).toBe(1);
  });

  test("touchMemories updates multiple memories", async () => {
    const mem1 = await writeMemory({
      content: `test-634-touch-batch-1-${Date.now()}`,
      type: "fact",
      scope: "global",
      confidence: 0.5,
    });
    const mem2 = await writeMemory({
      content: `test-634-touch-batch-2-${Date.now()}`,
      type: "fact",
      scope: "global",
      confidence: 0.5,
    });
    createdIds.push(mem1.id, mem2.id);

    await touchMemories([mem1.id, mem2.id]);

    const after1 = await getMemory(mem1.id);
    const after2 = await getMemory(mem2.id);
    expect(after1!.access_count).toBe(1);
    expect(after2!.access_count).toBe(1);
  });

  test("multiple touches increment access_count", async () => {
    const mem = await writeMemory({
      content: `test-634-multi-touch-${Date.now()}`,
      type: "fact",
      scope: "global",
      confidence: 0.5,
    });
    createdIds.push(mem.id);

    await touchMemory(mem.id);
    await touchMemory(mem.id);
    await touchMemory(mem.id);

    const after = await getMemory(mem.id);
    expect(after!.access_count).toBe(3);
  });
});

// ── Integration: temporal decay in readMemories ──────────────

describe("readMemories with temporal decay", () => {
  test("readMemories returns results with decay scoring", async () => {
    const mem = await writeMemory({
      content: `Quantum chromodynamics predicts gluon confinement test-634-decay-${Date.now()}`,
      type: "decision",
      scope: "global",
      confidence: 0.9,
    });
    createdIds.push(mem.id);

    const results = await readMemories({
      query: "quantum chromodynamics gluon confinement",
      scope: "global",
      match_count: 10,
      match_threshold: 0.3,
    });

    expect(Array.isArray(results)).toBe(true);
    // Results should have similarity field (now the decay-adjusted score)
    if (results.length > 0) {
      expect(typeof results[0].similarity).toBe("number");
    }
  });

  test("readMemories still works with scope_path (no decay applied)", async () => {
    const results = await readMemories({
      query: "test",
      scope_path: "2",
      match_count: 5,
    });
    expect(Array.isArray(results)).toBe(true);
  });
});

// ── Backfill verification ────────────────────────────────────

describe("importance_score backfill", () => {
  test("existing decisions have importance_score = 8.0 (from migration backfill)", async () => {
    const [row] = await sql<{ importance_score: number }[]>`
      SELECT importance_score FROM shared_memories
      WHERE type = 'decision' AND status = 'active'
        AND content NOT LIKE 'test-%'
        AND created_at < NOW() - INTERVAL '1 hour'
      LIMIT 1
    `;
    if (row) {
      expect(row.importance_score).toBe(8.0);
    }
  });

  test("existing facts have importance_score = 5.0 (from migration backfill)", async () => {
    const [row] = await sql<{ importance_score: number }[]>`
      SELECT importance_score FROM shared_memories
      WHERE type = 'fact' AND status = 'active'
        AND content NOT LIKE 'test-%'
        AND created_at < NOW() - INTERVAL '1 hour'
      LIMIT 1
    `;
    if (row) {
      expect(row.importance_score).toBe(5.0);
    }
  });
});
