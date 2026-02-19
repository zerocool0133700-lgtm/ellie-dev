/**
 * ELLIE-71 — Unit tests for memory conflict resolution (dedup via cosine similarity)
 *
 * Covers: resolveMemoryConflict heuristics, insertMemoryWithDedup flow,
 * processMemoryIntents dedup integration, merge metadata tracking,
 * visibility promotion, content upgrade logic.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  resolveMemoryConflict,
  checkMemoryConflict,
  insertMemoryWithDedup,
  processMemoryIntents,
  DEDUP_SIMILARITY_THRESHOLD,
  type SimilarMemory,
  type ConflictResult,
} from "../src/memory.ts";

// ── Helpers ─────────────────────────────────────────────────────

function createSimilarMemory(overrides?: Partial<SimilarMemory>): SimilarMemory {
  return {
    id: "existing-memory-id",
    content: "Dave prefers brief communication",
    type: "fact",
    source_agent: "general",
    visibility: "shared",
    metadata: {},
    similarity: 0.92,
    ...overrides,
  };
}

function createMockSupabaseForDedup(options?: {
  searchResults?: any[];
  searchError?: any;
  insertResult?: any;
  insertError?: any;
  updateError?: any;
}) {
  const {
    searchResults = [],
    searchError = null,
    insertResult = { id: "new-memory-id" },
    insertError = null,
    updateError = null,
  } = options || {};

  function createInsertChain() {
    const promise = Promise.resolve({
      data: insertError ? null : insertResult,
      error: insertError,
    });
    const chain: any = {};
    for (const method of ["select", "eq", "order", "limit"]) {
      chain[method] = (..._args: any[]) => chain;
    }
    chain.single = () => promise;
    chain.then = (resolve: Function, reject?: Function) => promise.then(resolve, reject);
    chain.catch = (reject: Function) => promise.catch(reject);
    return chain;
  }

  function createUpdateChain() {
    const promise = Promise.resolve({
      data: null,
      error: updateError,
    });
    const chain: any = {};
    for (const method of ["eq", "select"]) {
      chain[method] = (..._args: any[]) => chain;
    }
    chain.single = () => promise;
    chain.then = (resolve: Function, reject?: Function) => promise.then(resolve, reject);
    chain.catch = (reject: Function) => promise.catch(reject);
    return chain;
  }

  const fromMock = mock((table: string) => ({
    insert: () => createInsertChain(),
    update: () => createUpdateChain(),
    select: () => createInsertChain(),
  }));

  return {
    from: fromMock,
    functions: {
      invoke: mock((fnName: string, opts: any) => {
        if (fnName === "search") {
          return Promise.resolve({
            data: searchError ? null : searchResults,
            error: searchError,
          });
        }
        return Promise.resolve({ data: null, error: null });
      }),
    },
    rpc: mock(() => Promise.resolve({ data: [], error: null })),
  } as any;
}

// ══════════════════════════════════════════════════════════════════
// resolveMemoryConflict
// ══════════════════════════════════════════════════════════════════

describe("resolveMemoryConflict", () => {
  // ── Auto-merge (>= 0.95) ──────────────────────────────────────

  test("merges near-identical memories (similarity >= 0.95)", () => {
    const existing = createSimilarMemory({ similarity: 0.97 });
    const result = resolveMemoryConflict(existing, "Dave prefers brief comms", "research", "shared");
    expect(result.resolution).toBe("merge");
    expect(result.reason).toContain("Near-identical");
  });

  test("merges at exactly 0.95 threshold", () => {
    const existing = createSimilarMemory({ similarity: 0.95 });
    const result = resolveMemoryConflict(existing, "Dave prefers brief comms", "research", "shared");
    expect(result.resolution).toBe("merge");
  });

  // ── Same agent re-learning ─────────────────────────────────────

  test("merges when same agent re-learns the same fact", () => {
    const existing = createSimilarMemory({ similarity: 0.90, source_agent: "research" });
    const result = resolveMemoryConflict(existing, "Dave likes short replies", "research", "shared");
    expect(result.resolution).toBe("merge");
    expect(result.reason).toContain("re-learned");
  });

  // ── Different visibility ───────────────────────────────────────

  test("keeps both when visibility differs", () => {
    const existing = createSimilarMemory({ similarity: 0.90, visibility: "private" });
    const result = resolveMemoryConflict(existing, "Dave prefers brief communication style", "research", "shared");
    expect(result.resolution).toBe("keep_both");
    expect(result.reason).toContain("visibility");
  });

  // ── Length ratio (flag for user) ───────────────────────────────

  test("flags for user when new content is much longer (>2x)", () => {
    const existing = createSimilarMemory({
      similarity: 0.88,
      content: "Dave likes brevity",
      source_agent: "content",
    });
    const longContent = "Dave strongly prefers brief, concise communication. He dislikes verbose explanations and wants key points first. He has mentioned this preference multiple times across different conversations.";
    const result = resolveMemoryConflict(existing, longContent, "research", "shared");
    expect(result.resolution).toBe("flag_for_user");
    expect(result.reason).toContain("Length ratio");
  });

  test("flags for user when new content is much shorter (<0.5x)", () => {
    const existing = createSimilarMemory({
      similarity: 0.88,
      content: "Dave strongly prefers brief, concise communication. He dislikes verbose explanations and wants key points first with supporting details only when asked.",
      source_agent: "content",
    });
    const result = resolveMemoryConflict(existing, "Dave likes brevity", "research", "shared");
    expect(result.resolution).toBe("flag_for_user");
  });

  // ── Cross-agent corroboration ──────────────────────────────────

  test("merges for cross-agent corroboration with similar content", () => {
    const existing = createSimilarMemory({
      similarity: 0.90,
      source_agent: "content",
      visibility: "shared",
    });
    const result = resolveMemoryConflict(existing, "Dave prefers concise replies", "research", "shared");
    expect(result.resolution).toBe("merge");
    expect(result.reason).toContain("Cross-agent corroboration");
  });

  // ── Below threshold ────────────────────────────────────────────

  test("keeps both when below similarity threshold", () => {
    const existing = createSimilarMemory({ similarity: 0.80 });
    const result = resolveMemoryConflict(existing, "Something different", "research", "shared");
    expect(result.resolution).toBe("keep_both");
    expect(result.reason).toContain("below threshold");
  });

  // ── Return structure ───────────────────────────────────────────

  test("always returns existingMemory reference", () => {
    const existing = createSimilarMemory({ similarity: 0.97 });
    const result = resolveMemoryConflict(existing, "test", "general", "shared");
    expect(result.existingMemory).toBe(existing);
    expect(result.existingMemory?.id).toBe("existing-memory-id");
  });
});

// ══════════════════════════════════════════════════════════════════
// checkMemoryConflict
// ══════════════════════════════════════════════════════════════════

describe("checkMemoryConflict", () => {
  test("returns null when no similar memories found", async () => {
    const supabase = createMockSupabaseForDedup({ searchResults: [] });
    const result = await checkMemoryConflict(supabase, "Brand new fact", "fact");
    expect(result).toBeNull();
  });

  test("returns null when search Edge Function errors", async () => {
    const supabase = createMockSupabaseForDedup({ searchError: "Edge function unavailable" });
    const result = await checkMemoryConflict(supabase, "Some fact", "fact");
    expect(result).toBeNull();
  });

  test("returns best match of same type", async () => {
    const supabase = createMockSupabaseForDedup({
      searchResults: [
        { id: "mem-1", content: "Similar fact", type: "fact", source_agent: "general", visibility: "shared", metadata: {}, similarity: 0.92 },
        { id: "mem-2", content: "Another fact", type: "fact", source_agent: "research", visibility: "shared", metadata: {}, similarity: 0.87 },
      ],
    });
    const result = await checkMemoryConflict(supabase, "Similar fact here", "fact");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("mem-1");
    expect(result!.similarity).toBe(0.92);
  });

  test("filters by type — ignores goals when looking for facts", async () => {
    const supabase = createMockSupabaseForDedup({
      searchResults: [
        { id: "goal-1", content: "Similar content", type: "goal", source_agent: "general", visibility: "shared", metadata: {}, similarity: 0.95 },
      ],
    });
    const result = await checkMemoryConflict(supabase, "Similar content", "fact");
    expect(result).toBeNull();
  });

  test("calls search Edge Function with correct parameters", async () => {
    const supabase = createMockSupabaseForDedup({ searchResults: [] });
    await checkMemoryConflict(supabase, "Test query", "fact", 0.90);

    expect(supabase.functions.invoke).toHaveBeenCalledWith("search", {
      body: {
        query: "Test query",
        table: "memory",
        match_count: 3,
        match_threshold: 0.90,
      },
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// insertMemoryWithDedup
// ══════════════════════════════════════════════════════════════════

describe("insertMemoryWithDedup", () => {
  test("inserts normally when no conflict found", async () => {
    const supabase = createMockSupabaseForDedup({
      searchResults: [],
      insertResult: { id: "new-id" },
    });

    const result = await insertMemoryWithDedup(supabase, {
      type: "fact",
      content: "Brand new fact",
      source_agent: "general",
      visibility: "shared",
    });

    expect(result.action).toBe("inserted");
    expect(result.id).toBe("new-id");
    expect(result.resolution).toBeUndefined();
  });

  test("merges when near-identical duplicate found", async () => {
    const supabase = createMockSupabaseForDedup({
      searchResults: [
        { id: "existing-id", content: "Dave likes brevity", type: "fact", source_agent: "general", visibility: "shared", metadata: {}, similarity: 0.97 },
      ],
    });

    const result = await insertMemoryWithDedup(supabase, {
      type: "fact",
      content: "Dave likes brevity in communication",
      source_agent: "research",
      visibility: "shared",
    });

    expect(result.action).toBe("merged");
    expect(result.id).toBe("existing-id");
    expect(result.resolution?.resolution).toBe("merge");
  });

  test("flags for user when ambiguous conflict detected", async () => {
    const supabase = createMockSupabaseForDedup({
      searchResults: [
        { id: "existing-id", content: "Short fact", type: "fact", source_agent: "content", visibility: "shared", metadata: {}, similarity: 0.88 },
      ],
    });

    const result = await insertMemoryWithDedup(supabase, {
      type: "fact",
      content: "This is a much longer and more detailed version of the short fact that was previously stored, with additional context and nuance about the topic at hand, significantly expanding on the original.",
      source_agent: "research",
      visibility: "shared",
    });

    expect(result.action).toBe("flagged");
    expect(result.id).toBe("existing-id");
    expect(result.resolution?.resolution).toBe("flag_for_user");
  });

  test("keeps both when visibility differs", async () => {
    const supabase = createMockSupabaseForDedup({
      searchResults: [
        { id: "existing-id", content: "Similar content here", type: "fact", source_agent: "content", visibility: "private", metadata: {}, similarity: 0.90 },
      ],
      insertResult: { id: "new-id" },
    });

    const result = await insertMemoryWithDedup(supabase, {
      type: "fact",
      content: "Similar content here too",
      source_agent: "research",
      visibility: "shared",
    });

    expect(result.action).toBe("inserted");
    expect(result.id).toBe("new-id");
    expect(result.resolution?.resolution).toBe("keep_both");
  });

  test("handles insert error gracefully", async () => {
    const supabase = createMockSupabaseForDedup({
      searchResults: [],
      insertResult: null,
      insertError: { message: "Insert failed" },
    });

    const result = await insertMemoryWithDedup(supabase, {
      type: "fact",
      content: "Test fact",
      source_agent: "general",
      visibility: "shared",
    });

    expect(result.action).toBe("error");
    expect(result.id).toBeNull();
  });

  test("falls back to insert when merge update fails", async () => {
    const supabase = createMockSupabaseForDedup({
      searchResults: [
        { id: "existing-id", content: "Dave likes brevity", type: "fact", source_agent: "general", visibility: "shared", metadata: {}, similarity: 0.97 },
      ],
      updateError: { message: "Update failed" },
      insertResult: { id: "fallback-id" },
    });

    const result = await insertMemoryWithDedup(supabase, {
      type: "fact",
      content: "Dave likes brevity in communication",
      source_agent: "research",
      visibility: "shared",
    });

    // Falls back to insert when merge fails
    expect(result.action).toBe("inserted");
    expect(result.id).toBe("fallback-id");
  });
});

// ══════════════════════════════════════════════════════════════════
// processMemoryIntents (dedup integration)
// ══════════════════════════════════════════════════════════════════

describe("processMemoryIntents with dedup", () => {
  test("strips REMEMBER tags and returns clean response", async () => {
    const supabase = createMockSupabaseForDedup({
      searchResults: [],
      insertResult: { id: "new-id" },
    });

    const response = "Got it! [REMEMBER: Dave prefers TypeScript] I'll keep that in mind.";
    const clean = await processMemoryIntents(supabase, response, "general", "shared");

    expect(clean).toBe("Got it!  I'll keep that in mind.");
    expect(supabase.functions.invoke).toHaveBeenCalled();
  });

  test("handles REMEMBER-PRIVATE with dedup check", async () => {
    const supabase = createMockSupabaseForDedup({
      searchResults: [],
      insertResult: { id: "new-id" },
    });

    const response = "[REMEMBER-PRIVATE: Secret preference]";
    const clean = await processMemoryIntents(supabase, response, "general", "shared");

    expect(clean).toBe("");
  });

  test("handles REMEMBER-GLOBAL with dedup check", async () => {
    const supabase = createMockSupabaseForDedup({
      searchResults: [],
      insertResult: { id: "new-id" },
    });

    const response = "[REMEMBER-GLOBAL: System-wide fact]";
    const clean = await processMemoryIntents(supabase, response, "general", "shared");

    expect(clean).toBe("");
  });

  test("handles GOAL tags with dedup check", async () => {
    const supabase = createMockSupabaseForDedup({
      searchResults: [],
      insertResult: { id: "new-id" },
    });

    const response = "[GOAL: Learn Rust | DEADLINE: 2026-06-01]";
    const clean = await processMemoryIntents(supabase, response, "general", "shared");

    expect(clean).toBe("");
  });

  test("returns response unchanged when supabase is null", async () => {
    const response = "[REMEMBER: Something] Hello!";
    const clean = await processMemoryIntents(null, response, "general", "shared");
    expect(clean).toBe(response);
  });
});

// ══════════════════════════════════════════════════════════════════
// Merge metadata tracking
// ══════════════════════════════════════════════════════════════════

describe("merge metadata", () => {
  test("tracks alt_sources correctly on merge", async () => {
    let capturedUpdate: any = null;
    const supabase = createMockSupabaseForDedup({
      searchResults: [
        {
          id: "existing-id",
          content: "Dave uses Bun runtime",
          type: "fact",
          source_agent: "general",
          visibility: "shared",
          metadata: {},
          similarity: 0.97,
        },
      ],
    });

    // Override update to capture the payload
    supabase.from = mock((table: string) => ({
      insert: () => {
        const chain: any = {};
        for (const method of ["select", "eq"]) {
          chain[method] = () => chain;
        }
        chain.single = () => Promise.resolve({ data: { id: "new-id" }, error: null });
        chain.then = (r: Function) => Promise.resolve({ data: { id: "new-id" }, error: null }).then(r);
        return chain;
      },
      update: (payload: any) => {
        capturedUpdate = payload;
        const chain: any = {};
        chain.eq = () => chain;
        chain.then = (r: Function) => Promise.resolve({ data: null, error: null }).then(r);
        chain.catch = (r: Function) => Promise.resolve({ data: null, error: null }).catch(r);
        return chain;
      },
    }));

    await insertMemoryWithDedup(supabase, {
      type: "fact",
      content: "Dave uses the Bun runtime",
      source_agent: "research",
      visibility: "shared",
    });

    expect(capturedUpdate).not.toBeNull();
    expect(capturedUpdate.metadata.alt_sources).toContain("research");
    expect(capturedUpdate.metadata.corroboration_count).toBe(1);
    expect(capturedUpdate.metadata.last_corroborated_at).toBeTruthy();
  });

  test("accumulates alt_sources on repeated merges", async () => {
    let capturedUpdate: any = null;
    const supabase = createMockSupabaseForDedup({
      searchResults: [
        {
          id: "existing-id",
          content: "Dave uses Bun runtime",
          type: "fact",
          source_agent: "general",
          visibility: "shared",
          metadata: {
            alt_sources: ["content"],
            corroboration_count: 1,
          },
          similarity: 0.97,
        },
      ],
    });

    supabase.from = mock((table: string) => ({
      insert: () => {
        const chain: any = {};
        for (const method of ["select", "eq"]) {
          chain[method] = () => chain;
        }
        chain.single = () => Promise.resolve({ data: { id: "new-id" }, error: null });
        chain.then = (r: Function) => Promise.resolve({ data: { id: "new-id" }, error: null }).then(r);
        return chain;
      },
      update: (payload: any) => {
        capturedUpdate = payload;
        const chain: any = {};
        chain.eq = () => chain;
        chain.then = (r: Function) => Promise.resolve({ data: null, error: null }).then(r);
        chain.catch = (r: Function) => Promise.resolve({ data: null, error: null }).catch(r);
        return chain;
      },
    }));

    await insertMemoryWithDedup(supabase, {
      type: "fact",
      content: "Dave uses the Bun runtime for JS",
      source_agent: "research",
      visibility: "shared",
    });

    expect(capturedUpdate).not.toBeNull();
    // Should have both content and research as alt_sources
    expect(capturedUpdate.metadata.alt_sources).toContain("content");
    expect(capturedUpdate.metadata.alt_sources).toContain("research");
    expect(capturedUpdate.metadata.corroboration_count).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════════
// Edge cases
// ══════════════════════════════════════════════════════════════════

describe("edge cases", () => {
  test("DEDUP_SIMILARITY_THRESHOLD is 0.85", () => {
    expect(DEDUP_SIMILARITY_THRESHOLD).toBe(0.85);
  });

  test("resolves keep_both for exact threshold boundary (0.85 with different visibility)", () => {
    const existing = createSimilarMemory({
      similarity: 0.85,
      visibility: "private",
      source_agent: "content",
    });
    const result = resolveMemoryConflict(existing, "Similar content", "research", "global");
    expect(result.resolution).toBe("keep_both");
  });

  test("handles empty metadata in existing memory", () => {
    const existing = createSimilarMemory({ metadata: {} });
    const result = resolveMemoryConflict(existing, "Test", "general", "shared");
    expect(result.existingMemory?.metadata).toEqual({});
  });

  test("handles null/undefined metadata fields gracefully", () => {
    const existing = createSimilarMemory({
      similarity: 0.97,
      metadata: { alt_sources: undefined } as any,
    });
    // Should not throw
    const result = resolveMemoryConflict(existing, "Test", "general", "shared");
    expect(result.resolution).toBe("merge");
  });
});
