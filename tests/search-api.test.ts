/**
 * ELLIE-633 — Tests for the unified search API.
 *
 * Tests cover:
 * 1. mergeResults() — deduplication and score normalization logic
 * 2. GET /api/search endpoint (integration, hits live relay)
 * 3. GET /api/conversations/:id endpoint (integration)
 */

import { describe, test, expect } from "bun:test";
import { mergeResults, type SearchResult } from "../src/api/search.ts";

const RELAY = process.env.RELAY_URL || "http://localhost:3001";

// ── Unit tests: mergeResults ────────────────────────────────

describe("mergeResults", () => {
  test("merges keyword and semantic results, deduplicating by ID", () => {
    const keyword: SearchResult[] = [
      { id: "a1", type: "message", content: "Hello world from keyword", score: 10, source: "keyword" },
      { id: "a2", type: "message", content: "Second keyword result", score: 8, source: "keyword" },
    ];
    const semantic: SearchResult[] = [
      { id: "a1", type: "message", content: "Hello world from keyword", score: 0.9, source: "semantic" },
      { id: "b1", type: "memory", content: "Semantic only result", score: 0.85, source: "semantic" },
    ];

    const merged = mergeResults(keyword, semantic, 10);

    // a1 should appear only once (deduped)
    const a1Count = merged.filter((r) => r.id === "a1").length;
    expect(a1Count).toBe(1);

    // All unique results should be present
    expect(merged.length).toBe(3);

    // b1 should be included
    expect(merged.some((r) => r.id === "b1")).toBe(true);
  });

  test("deduplicates by content substring when IDs differ", () => {
    const keyword: SearchResult[] = [
      { id: "x1", type: "message", content: "This is a long message about elasticsearch indexing strategies for production use", score: 12, source: "keyword" },
    ];
    const semantic: SearchResult[] = [
      { id: "x2", type: "message", content: "This is a long message about elasticsearch indexing strategies for production use", score: 0.92, source: "semantic" },
    ];

    const merged = mergeResults(keyword, semantic, 10);
    expect(merged.length).toBe(1);
  });

  test("respects limit parameter", () => {
    const keyword: SearchResult[] = Array.from({ length: 10 }, (_, i) => ({
      id: `kw-${i}`,
      type: "message" as const,
      content: `Keyword result ${i} with unique content`,
      score: 10 - i,
      source: "keyword" as const,
    }));

    const merged = mergeResults(keyword, [], 3);
    expect(merged.length).toBe(3);
  });

  test("normalizes keyword scores to 0-1 range for fair comparison", () => {
    const keyword: SearchResult[] = [
      { id: "kw1", type: "message", content: "High score keyword unique content A", score: 20, source: "keyword" },
    ];
    const semantic: SearchResult[] = [
      { id: "sem1", type: "message", content: "High similarity semantic unique content B", score: 0.95, source: "semantic" },
    ];

    const merged = mergeResults(keyword, semantic, 10);

    // Both should be present — keyword score 20 normalizes to 1.0, semantic is 0.95
    expect(merged.length).toBe(2);
    // Keyword result should come first (normalized 1.0 > 0.95)
    expect(merged[0].id).toBe("kw1");
  });

  test("handles empty inputs", () => {
    expect(mergeResults([], [], 10)).toEqual([]);
    expect(mergeResults([], [{ id: "s1", type: "message", content: "Semantic only unique content", score: 0.8, source: "semantic" }], 10)).toHaveLength(1);
    expect(mergeResults([{ id: "k1", type: "message", content: "Keyword only unique content", score: 5, source: "keyword" }], [], 10)).toHaveLength(1);
  });

  test("preserves all fields in merged results", () => {
    const keyword: SearchResult[] = [{
      id: "full-1",
      type: "message",
      content: "Full field test message with all properties",
      role: "user",
      channel: "telegram",
      conversation_id: "conv-123",
      created_at: "2026-03-07T00:00:00Z",
      score: 10,
      source: "keyword",
    }];

    const merged = mergeResults(keyword, [], 10);
    expect(merged[0]).toEqual({
      id: "full-1",
      type: "message",
      content: "Full field test message with all properties",
      role: "user",
      channel: "telegram",
      conversation_id: "conv-123",
      created_at: "2026-03-07T00:00:00Z",
      score: 10,
      source: "keyword",
    });
  });
});

// ── Integration tests: /api/search ──────────────────────────

describe("GET /api/search", () => {
  test("returns 400 when q parameter is missing", async () => {
    const res = await fetch(`${RELAY}/api/search`);
    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toContain("Missing");
  });

  test("returns success structure with valid query", async () => {
    const res = await fetch(`${RELAY}/api/search?q=test+message&mode=keyword&limit=5`);
    const data = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.query).toBe("test message");
    expect(data.mode).toBe("keyword");
    expect(Array.isArray(data.results)).toBe(true);
  });

  test("accepts all three search modes", async () => {
    for (const mode of ["keyword", "semantic", "hybrid"]) {
      const res = await fetch(`${RELAY}/api/search?q=hello&mode=${mode}&limit=3`);
      expect(res.status).toBe(200);
      const data = await res.json() as { mode: string };
      expect(data.mode).toBe(mode);
    }
  }, 15000);

  test("defaults to hybrid mode when mode not specified", async () => {
    const res = await fetch(`${RELAY}/api/search?q=ellie+assistant`);
    const data = await res.json() as { mode: string };
    expect(res.status).toBe(200);
    expect(data.mode).toBe("hybrid");
  });

  test("respects limit parameter", async () => {
    const res = await fetch(`${RELAY}/api/search?q=test&mode=keyword&limit=2`);
    const data = await res.json() as { results: unknown[] };
    expect(res.status).toBe(200);
    // Results should not exceed limit (may be fewer if not enough matches)
    expect(data.results.length).toBeLessThanOrEqual(2);
  });

  test("caps limit at 50", async () => {
    const res = await fetch(`${RELAY}/api/search?q=test&mode=keyword&limit=200`);
    const data = await res.json() as { count: number };
    expect(res.status).toBe(200);
    expect(data.count).toBeLessThanOrEqual(50);
  });

  test("results have expected shape", async () => {
    const res = await fetch(`${RELAY}/api/search?q=good+morning&mode=keyword&limit=3`);
    const data = await res.json() as { results: Array<Record<string, unknown>> };

    if (data.results.length > 0) {
      const result = data.results[0];
      expect(typeof result.id).toBe("string");
      expect(["message", "memory", "conversation"]).toContain(result.type);
      expect(typeof result.content).toBe("string");
      expect(typeof result.score).toBe("number");
      expect(["keyword", "semantic"]).toContain(result.source);
    }
  });

  test("channel filter is accepted", async () => {
    const res = await fetch(`${RELAY}/api/search?q=test&mode=keyword&channel=telegram`);
    expect(res.status).toBe(200);
  });

  test("date range filters are accepted", async () => {
    const res = await fetch(`${RELAY}/api/search?q=test&mode=keyword&dateFrom=2026-01-01&dateTo=2026-03-07`);
    expect(res.status).toBe(200);
  });
});

// ── Integration tests: /api/conversations/:id ───────────────

describe("GET /api/conversations/:id", () => {
  test("returns 404 for non-existent conversation", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await fetch(`${RELAY}/api/conversations/${fakeId}`);
    expect(res.status).toBe(404);
  });

  test("returns 400 for missing ID", async () => {
    const res = await fetch(`${RELAY}/api/conversations/`);
    // May be 400 or 404 depending on routing
    expect([400, 404]).toContain(res.status);
  });
});
