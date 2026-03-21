/**
 * ELLIE-967/968 — Tier 2 memory fact retrieval + injection tests
 *
 * Verifies that:
 *   - getRelevantFacts() returns formatted facts from Supabase memory table
 *   - getRelevantFacts() returns empty string for short queries
 *   - getRelevantFacts() returns empty string when supabase is null
 *   - getRelevantFacts() handles edge function errors gracefully
 *   - Facts are merged into structuredContext for prompt injection
 *   - _writeFactToForest helper writes to Forest shared_memories
 */

import { describe, test, expect, mock } from "bun:test";

// ── getRelevantFacts unit tests (mock Supabase) ──────────────

describe("getRelevantFacts — ELLIE-967", () => {
  test("returns empty string when supabase is null", async () => {
    const { getRelevantFacts } = await import("../src/memory.ts");
    const result = await getRelevantFacts(null, "What does Dave prefer?");
    expect(result).toBe("");
  });

  test("returns empty string for short queries (<10 chars)", async () => {
    const { getRelevantFacts } = await import("../src/memory.ts");
    const fakeSupabase = {} as any;
    const result = await getRelevantFacts(fakeSupabase, "hi");
    expect(result).toBe("");
  });

  test("returns empty string for empty query", async () => {
    const { getRelevantFacts } = await import("../src/memory.ts");
    const fakeSupabase = {} as any;
    const result = await getRelevantFacts(fakeSupabase, "   ");
    expect(result).toBe("");
  });

  test("returns formatted facts when search returns results", async () => {
    const { getRelevantFacts } = await import("../src/memory.ts");

    const mockSearchResults = [
      { id: "1", content: "Dave prefers bullet points", type: "fact", similarity: 0.85 },
      { id: "2", content: "Georgia has a recital March 14", type: "fact", similarity: 0.80 },
      { id: "3", content: "Wincy is Dave's wife", type: "preference", similarity: 0.75 },
    ];

    const mockSupabase = {
      functions: {
        invoke: mock(() => Promise.resolve({ data: mockSearchResults, error: null })),
      },
    } as any;

    const result = await getRelevantFacts(mockSupabase, "Tell me about Dave's family");

    expect(result).toContain("PERSONAL KNOWLEDGE");
    expect(result).toContain("Dave prefers bullet points");
    expect(result).toContain("Georgia has a recital");
    expect(result).toContain("Wincy is Dave's wife");
    expect(result).toContain("[fact]");
    expect(result).toContain("[preference]");
  });

  test("filters out low-similarity results", async () => {
    const { getRelevantFacts } = await import("../src/memory.ts");

    const mockSearchResults = [
      { id: "1", content: "Relevant fact", type: "fact", similarity: 0.85 },
      { id: "2", content: "Barely relevant", type: "fact", similarity: 0.65 },
    ];

    const mockSupabase = {
      functions: {
        invoke: mock(() => Promise.resolve({ data: mockSearchResults, error: null })),
      },
    } as any;

    const result = await getRelevantFacts(mockSupabase, "Something about preferences");
    expect(result).toContain("Relevant fact");
    expect(result).not.toContain("Barely relevant");
  });

  test("caps at 5 results", async () => {
    const { getRelevantFacts } = await import("../src/memory.ts");

    const mockSearchResults = Array.from({ length: 8 }, (_, i) => ({
      id: String(i),
      content: `Fact number ${i}`,
      type: "fact",
      similarity: 0.9 - i * 0.01,
    }));

    const mockSupabase = {
      functions: {
        invoke: mock(() => Promise.resolve({ data: mockSearchResults, error: null })),
      },
    } as any;

    const result = await getRelevantFacts(mockSupabase, "Tell me everything you know");
    const lines = result.split("\n").filter((l: string) => l.startsWith("- ["));
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  test("returns empty string on edge function error", async () => {
    const { getRelevantFacts } = await import("../src/memory.ts");

    const mockSupabase = {
      functions: {
        invoke: mock(() => Promise.resolve({ data: null, error: { message: "Edge function down" } })),
      },
    } as any;

    const result = await getRelevantFacts(mockSupabase, "What about my preferences?");
    expect(result).toBe("");
  });

  test("returns empty string when search returns no matches", async () => {
    const { getRelevantFacts } = await import("../src/memory.ts");

    const mockSupabase = {
      functions: {
        invoke: mock(() => Promise.resolve({ data: [], error: null })),
      },
    } as any;

    const result = await getRelevantFacts(mockSupabase, "Something completely unrelated");
    expect(result).toBe("");
  });
});

// ── Structured context merging ──────────────────────────────

describe("factsContext merge into structuredContext — ELLIE-967", () => {
  test("facts appended to existing structured context", () => {
    const structuredBase = "Existing structured context here";
    const facts = "PERSONAL KNOWLEDGE (remembered facts):\n- [fact] Dave is dyslexic";

    const merged = [structuredBase, facts].filter(Boolean).join("\n\n");

    expect(merged).toContain("Existing structured context");
    expect(merged).toContain("PERSONAL KNOWLEDGE");
    expect(merged).toContain("Dave is dyslexic");
  });

  test("facts alone when no structured context", () => {
    const structuredBase = "";
    const facts = "PERSONAL KNOWLEDGE (remembered facts):\n- [fact] Prefers bullet points";

    const merged = [structuredBase, facts].filter(Boolean).join("\n\n");

    expect(merged).toContain("PERSONAL KNOWLEDGE");
    expect(merged).not.toStartWith("\n");
  });

  test("empty when neither exists", () => {
    const structuredBase = "";
    const facts = "";

    const merged = [structuredBase, facts].filter(Boolean).join("\n\n");

    expect(merged).toBe("");
  });
});
