import { describe, it, expect } from "bun:test";
import {
  resolveMemoryConflict,
  type SimilarMemory,
  DEDUP_SIMILARITY_THRESHOLD,
} from "./memory.ts";

function makeSimilarMemory(overrides: Partial<SimilarMemory> = {}): SimilarMemory {
  return {
    id: "mem-001",
    content: "The user prefers dark mode",
    type: "fact",
    source_agent: "general",
    visibility: "shared",
    metadata: {},
    similarity: 0.90,
    ...overrides,
  };
}

describe("resolveMemoryConflict", () => {
  // ── Near-identical (>= 0.95) — always merge ────────────────

  it("merges near-identical memories (similarity >= 0.95)", () => {
    const existing = makeSimilarMemory({ similarity: 0.97 });
    const result = resolveMemoryConflict(existing, "User likes dark mode", "research", "shared");

    expect(result.resolution).toBe("merge");
    expect(result.reason).toContain("Near-identical");
    expect(result.reason).toContain("0.970");
  });

  it("merges at exactly 0.95 threshold", () => {
    const existing = makeSimilarMemory({ similarity: 0.95 });
    const result = resolveMemoryConflict(existing, "User likes dark mode", "research", "shared");

    expect(result.resolution).toBe("merge");
  });

  // ── Below threshold — keep_both ────────────────────────────

  it("keeps both when similarity below threshold", () => {
    const existing = makeSimilarMemory({ similarity: 0.80 });
    const result = resolveMemoryConflict(existing, "Something different", "dev", "shared");

    expect(result.resolution).toBe("keep_both");
    expect(result.reason).toContain("below threshold");
  });

  // ── Ambiguous zone: same agent → merge ──────────────────────

  it("merges when same agent re-learns in ambiguous zone", () => {
    const existing = makeSimilarMemory({
      similarity: 0.90,
      source_agent: "dev",
    });
    const result = resolveMemoryConflict(existing, "User prefers dark themes", "dev", "shared");

    expect(result.resolution).toBe("merge");
    expect(result.reason).toContain("Same agent");
    expect(result.reason).toContain("dev");
  });

  // ── Ambiguous zone: different visibility → keep_both ────────

  it("keeps both when different visibility in ambiguous zone", () => {
    const existing = makeSimilarMemory({
      similarity: 0.90,
      source_agent: "general",
      visibility: "shared",
    });
    const result = resolveMemoryConflict(existing, "Similar content", "research", "private");

    expect(result.resolution).toBe("keep_both");
    expect(result.reason).toContain("Different visibility");
  });

  // ── Ambiguous zone: length ratio > 2x → flag_for_user ──────

  it("flags for user when new content is much longer", () => {
    const existing = makeSimilarMemory({
      similarity: 0.90,
      source_agent: "general",
      visibility: "shared",
      content: "Short fact",
    });
    const result = resolveMemoryConflict(
      existing,
      "This is a much longer and more detailed version of the fact with extra context and explanation",
      "research",
      "shared",
    );

    expect(result.resolution).toBe("flag_for_user");
    expect(result.reason).toContain("Length ratio");
  });

  it("flags for user when new content is much shorter", () => {
    const existing = makeSimilarMemory({
      similarity: 0.90,
      source_agent: "general",
      visibility: "shared",
      content: "This is a very detailed and long explanation of the concept with many examples and context",
    });
    const result = resolveMemoryConflict(existing, "Brief note", "research", "shared");

    expect(result.resolution).toBe("flag_for_user");
    expect(result.reason).toContain("Length ratio");
  });

  // ── Ambiguous zone: cross-agent corroboration → merge ───────

  it("merges for cross-agent corroboration in ambiguous zone", () => {
    const existing = makeSimilarMemory({
      similarity: 0.90,
      source_agent: "general",
      visibility: "shared",
      content: "The user prefers dark mode interfaces",
    });
    // Similar length, same visibility, different agent
    const result = resolveMemoryConflict(
      existing,
      "The user likes dark mode for their UI",
      "research",
      "shared",
    );

    expect(result.resolution).toBe("merge");
    expect(result.reason).toContain("Cross-agent corroboration");
  });

  // ── Always returns the existing memory reference ────────────

  it("always includes existingMemory in result", () => {
    const existing = makeSimilarMemory({ similarity: 0.97 });
    const result = resolveMemoryConflict(existing, "Anything", "dev", "shared");

    expect(result.existingMemory).toBe(existing);
  });

  // ── Threshold constant is correct ──────────────────────────

  it("exports the correct dedup threshold", () => {
    expect(DEDUP_SIMILARITY_THRESHOLD).toBe(0.85);
  });
});
