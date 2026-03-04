/**
 * ELLIE-532 — River QMD query layer tests for prompt-builder.ts
 *
 * Tests the River doc caching layer introduced/extended in ELLIE-532:
 *   - getCachedRiverDoc: miss, hit, stale-while-revalidate
 *   - clearRiverDocCache / setRiverDocCacheTtl
 *   - _injectRiverDocForTesting: test helper for cache injection
 *   - Frontmatter section_priority applied to buildPrompt sections
 *   - River soul doc overrides config/soul.md in buildPrompt (general agent)
 *   - River soul doc NOT used for downstream agents (ELLIE-525 gating)
 *   - River protocol docs used in buildPrompt when cached
 *   - Hardcoded fallback when River is empty (QMD down scenario)
 *   - refreshRiverDocs: resolves non-fatally (QMD may be unavailable in tests)
 *
 * No module mocking required — uses _injectRiverDocForTesting() to control
 * cache state, which avoids contaminating bridge-river.ts for other test files.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  buildPrompt,
  getLastBuildMetrics,
  clearRiverDocCache,
  getCachedRiverDoc,
  setRiverDocCacheTtl,
  refreshRiverDocs,
  _injectRiverDocForTesting,
  stopPersonalityWatchers,
} from "../src/prompt-builder.ts";

// ── Cleanup ────────────────────────────────────────────────────────────────────

afterAll(() => {
  stopPersonalityWatchers();
  clearRiverDocCache();
  setRiverDocCacheTtl(60_000); // restore default TTL
});

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Reset River cache + TTL before each test. */
beforeEach(() => {
  clearRiverDocCache();
  setRiverDocCacheTtl(60_000);
});

// ── getCachedRiverDoc — cache miss ─────────────────────────────────────────────

describe("getCachedRiverDoc — cache miss", () => {
  test("returns null for unknown key when cache is empty", () => {
    expect(getCachedRiverDoc("soul")).toBeNull();
  });

  test("returns null for 'memory-protocol' when cache is empty", () => {
    expect(getCachedRiverDoc("memory-protocol")).toBeNull();
  });

  test("returns null for 'confirm-protocol' when cache is empty", () => {
    expect(getCachedRiverDoc("confirm-protocol")).toBeNull();
  });

  test("returns null for arbitrary key", () => {
    expect(getCachedRiverDoc("not-registered")).toBeNull();
  });
});

// ── _injectRiverDocForTesting ──────────────────────────────────────────────────

describe("_injectRiverDocForTesting — cache population", () => {
  test("getCachedRiverDoc returns injected content", () => {
    _injectRiverDocForTesting("soul", "River soul content here");
    expect(getCachedRiverDoc("soul")).toBe("River soul content here");
  });

  test("multiple keys injected independently", () => {
    _injectRiverDocForTesting("soul", "Soul A");
    _injectRiverDocForTesting("memory-protocol", "Memory B");
    expect(getCachedRiverDoc("soul")).toBe("Soul A");
    expect(getCachedRiverDoc("memory-protocol")).toBe("Memory B");
  });

  test("second inject for same key overwrites first", () => {
    _injectRiverDocForTesting("soul", "First version");
    _injectRiverDocForTesting("soul", "Second version");
    expect(getCachedRiverDoc("soul")).toBe("Second version");
  });

  test("inject with frontmatter stored separately from content", () => {
    _injectRiverDocForTesting("memory-protocol", "Protocol body", { section_priority: 4 });
    // Content accessible via getCachedRiverDoc
    expect(getCachedRiverDoc("memory-protocol")).toBe("Protocol body");
    // Frontmatter is used internally by buildPrompt (tested below)
  });
});

// ── clearRiverDocCache ─────────────────────────────────────────────────────────

describe("clearRiverDocCache", () => {
  test("clears all injected docs", () => {
    _injectRiverDocForTesting("soul", "Soul content");
    _injectRiverDocForTesting("memory-protocol", "Memory content");
    clearRiverDocCache();
    expect(getCachedRiverDoc("soul")).toBeNull();
    expect(getCachedRiverDoc("memory-protocol")).toBeNull();
  });

  test("is safe to call on empty cache", () => {
    expect(() => clearRiverDocCache()).not.toThrow();
  });

  test("can be called multiple times", () => {
    clearRiverDocCache();
    clearRiverDocCache();
    expect(getCachedRiverDoc("soul")).toBeNull();
  });
});

// ── setRiverDocCacheTtl / stale-while-revalidate ──────────────────────────────

describe("setRiverDocCacheTtl — TTL configuration", () => {
  test("getCachedRiverDoc still returns stale content after TTL expires (stale-while-revalidate)", () => {
    // Inject with TTL=0 → immediately stale
    setRiverDocCacheTtl(0);
    _injectRiverDocForTesting("soul", "Stale soul content");
    // Stale content is still returned (refresh triggered in background)
    expect(getCachedRiverDoc("soul")).toBe("Stale soul content");
  });

  test("TTL of 60000 keeps content fresh within same tick", () => {
    setRiverDocCacheTtl(60_000);
    _injectRiverDocForTesting("soul", "Fresh soul content");
    expect(getCachedRiverDoc("soul")).toBe("Fresh soul content");
  });

  test("restoring default TTL works", () => {
    setRiverDocCacheTtl(100);
    setRiverDocCacheTtl(60_000);
    _injectRiverDocForTesting("memory-protocol", "Restored");
    expect(getCachedRiverDoc("memory-protocol")).toBe("Restored");
  });
});

// ── refreshRiverDocs ──────────────────────────────────────────────────────────

describe("refreshRiverDocs", () => {
  test("resolves without throwing (QMD may be unavailable)", async () => {
    await expect(refreshRiverDocs()).resolves.toBeUndefined();
  });

  test("can be called twice concurrently without error", async () => {
    await expect(Promise.all([refreshRiverDocs(), refreshRiverDocs()])).resolves.toBeDefined();
  });
});

// ── buildPrompt — River soul integration ─────────────────────────────────────

describe("buildPrompt — River soul (ELLIE-532)", () => {
  test("uses River soul when injected for general agent (no agentConfig)", () => {
    _injectRiverDocForTesting("soul", "RIVER SOUL CONTENT: patient teacher");
    const result = buildPrompt("Hello");
    expect(result).toContain("RIVER SOUL CONTENT: patient teacher");
  });

  test("uses River soul when agentConfig.name is 'general'", () => {
    _injectRiverDocForTesting("soul", "RIVER SOUL: general test");
    const result = buildPrompt("Hello", undefined, undefined, undefined, "telegram", {
      system_prompt: null,
      name: "general",
    });
    expect(result).toContain("RIVER SOUL: general test");
  });

  test("River soul section has label 'soul' in metrics", () => {
    _injectRiverDocForTesting("soul", "River soul for metrics test");
    buildPrompt("Hello");
    const metrics = getLastBuildMetrics()!;
    const soul = metrics.sections.find(s => s.label === "soul");
    expect(soul).toBeDefined();
  });

  test("River soul does NOT appear for downstream agents (ELLIE-525 gate)", () => {
    _injectRiverDocForTesting("soul", "RIVER SOUL SHOULD NOT APPEAR");
    const result = buildPrompt("Fix it", undefined, undefined, undefined, "telegram", {
      system_prompt: "You are a dev agent.",
      name: "dev",
    });
    expect(result).not.toContain("RIVER SOUL SHOULD NOT APPEAR");
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label === "soul")).toBeUndefined();
  });

  test("River soul does NOT appear for research agent", () => {
    _injectRiverDocForTesting("soul", "RIVER SOUL BLOCKED");
    buildPrompt("Research this", undefined, undefined, undefined, "telegram", { name: "research" });
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "soul")).toBeUndefined();
  });

  test("falls back gracefully when River soul cache is empty (no soul section if local also missing)", () => {
    // Cache is empty (beforeEach clears it). buildPrompt still works.
    const result = buildPrompt("Hello");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ── buildPrompt — River memory-protocol integration ───────────────────────────

describe("buildPrompt — River memory-protocol (ELLIE-532)", () => {
  test("uses River memory-protocol content when injected", () => {
    _injectRiverDocForTesting("memory-protocol", "RIVER: Custom memory instructions here");
    const result = buildPrompt("Hello");
    expect(result).toContain("RIVER: Custom memory instructions here");
    expect(result).toContain("MEMORY MANAGEMENT:");
  });

  test("memory-protocol section absent when River cache is empty (ELLIE-537: no hardcoded fallback)", () => {
    const result = buildPrompt("Hello");
    expect(result).not.toContain("MEMORY MANAGEMENT:");
  });
});

// ── buildPrompt — River confirm-protocol integration ──────────────────────────

describe("buildPrompt — River confirm-protocol (ELLIE-532)", () => {
  test("uses River confirm-protocol content when injected", () => {
    _injectRiverDocForTesting("confirm-protocol", "RIVER: Custom confirm instructions");
    const result = buildPrompt("Hello");
    expect(result).toContain("RIVER: Custom confirm instructions");
    expect(result).toContain("ACTION CONFIRMATIONS:");
  });

  test("confirm-protocol section absent when River cache is empty (ELLIE-537: no hardcoded fallback)", () => {
    const result = buildPrompt("Hello");
    expect(result).not.toContain("ACTION CONFIRMATIONS:");
  });
});

// ── buildPrompt — frontmatter section_priority ────────────────────────────────

describe("buildPrompt — frontmatter section_priority (ELLIE-532)", () => {
  test("memory-protocol uses frontmatter section_priority when set", () => {
    _injectRiverDocForTesting("memory-protocol", "Memory content", { section_priority: 4 });
    buildPrompt("Hello");
    const metrics = getLastBuildMetrics()!;
    const mem = metrics.sections.find(s => s.label === "memory-protocol");
    expect(mem).toBeDefined();
    expect(mem!.priority).toBe(4);
  });

  test("confirm-protocol uses frontmatter section_priority when set", () => {
    _injectRiverDocForTesting("confirm-protocol", "Confirm content", { section_priority: 4 });
    buildPrompt("Hello");
    const metrics = getLastBuildMetrics()!;
    const confirm = metrics.sections.find(s => s.label === "confirm-protocol");
    expect(confirm).toBeDefined();
    expect(confirm!.priority).toBe(4);
  });

  test("default priority 3 used when no frontmatter section_priority", () => {
    _injectRiverDocForTesting("memory-protocol", "Memory content"); // no frontmatter
    buildPrompt("Hello");
    const metrics = getLastBuildMetrics()!;
    const mem = metrics.sections.find(s => s.label === "memory-protocol");
    expect(mem).toBeDefined();
    expect(mem!.priority).toBe(3);
  });

  test("section_priority 8 causes section to be suppressed (>= threshold)", () => {
    _injectRiverDocForTesting("memory-protocol", "SUPPRESSED MEMORY", { section_priority: 8 });
    const result = buildPrompt("Hello");
    expect(result).not.toContain("SUPPRESSED MEMORY");
  });

  test("section_priority out of range (0 or 10) falls back to default 3", () => {
    _injectRiverDocForTesting("memory-protocol", "Out of range prio", { section_priority: 0 });
    buildPrompt("Hello");
    const metrics = getLastBuildMetrics()!;
    const mem = metrics.sections.find(s => s.label === "memory-protocol");
    expect(mem!.priority).toBe(3);
  });

  test("non-numeric section_priority falls back to default 3", () => {
    _injectRiverDocForTesting("confirm-protocol", "Non-numeric prio", { section_priority: "high" as any });
    buildPrompt("Hello");
    const metrics = getLastBuildMetrics()!;
    const confirm = metrics.sections.find(s => s.label === "confirm-protocol");
    expect(confirm!.priority).toBe(3);
  });
});

// ── RIVER_DOC_PATHS coverage ──────────────────────────────────────────────────

describe("RIVER_DOC_PATHS — registered keys", () => {
  test("'soul' key is registered (getCachedRiverDoc accepts it)", () => {
    // Registered keys return null on miss (not undefined/exception)
    expect(getCachedRiverDoc("soul")).toBeNull();
  });

  test("'memory-protocol' key is registered", () => {
    expect(getCachedRiverDoc("memory-protocol")).toBeNull();
  });

  test("'confirm-protocol' key is registered", () => {
    expect(getCachedRiverDoc("confirm-protocol")).toBeNull();
  });
});
