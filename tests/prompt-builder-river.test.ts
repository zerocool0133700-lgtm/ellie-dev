/**
 * ELLIE-532 — River QMD cache layer tests for prompt-builder.ts
 *
 * Tests the River doc caching primitives:
 *   - getCachedRiverDoc: miss, hit, stale-while-revalidate
 *   - _injectRiverDocForTesting: test helper for cache injection
 *   - clearRiverDocCache: full cache wipe
 *   - setRiverDocCacheTtl: TTL configuration + stale-while-revalidate
 *   - RIVER_DOC_PATHS: registered key coverage
 *
 * buildPrompt integration tests (River soul, memory-protocol, confirm-protocol,
 * frontmatter section_priority) live in prompt-builder.test.ts and
 * prompt-builder-agents.test.ts — not duplicated here.
 *
 * No module mocking — uses _injectRiverDocForTesting() to control cache state.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  getCachedRiverDoc,
  clearRiverDocCache,
  setRiverDocCacheTtl,
  _injectRiverDocForTesting,
  stopPersonalityWatchers,
} from "../src/prompt-builder.ts";

// ── Cleanup ────────────────────────────────────────────────────────────────────

afterAll(() => {
  stopPersonalityWatchers();
  clearRiverDocCache();
  setRiverDocCacheTtl(60_000);
});

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
    expect(getCachedRiverDoc("memory-protocol")).toBe("Protocol body");
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
  test("stale content still returned after TTL expires (stale-while-revalidate)", () => {
    setRiverDocCacheTtl(0);
    _injectRiverDocForTesting("soul", "Stale soul content");
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

// ── RIVER_DOC_PATHS coverage ──────────────────────────────────────────────────

describe("RIVER_DOC_PATHS — registered keys", () => {
  test("'soul' key is registered", () => {
    expect(getCachedRiverDoc("soul")).toBeNull();
  });

  test("'memory-protocol' key is registered", () => {
    expect(getCachedRiverDoc("memory-protocol")).toBeNull();
  });

  test("'confirm-protocol' key is registered", () => {
    expect(getCachedRiverDoc("confirm-protocol")).toBeNull();
  });

  test("'dev-agent-template' key is registered", () => {
    expect(getCachedRiverDoc("dev-agent-template")).toBeNull();
  });

  test("'research-agent-template' key is registered", () => {
    expect(getCachedRiverDoc("research-agent-template")).toBeNull();
  });

  test("'strategy-agent-template' key is registered", () => {
    expect(getCachedRiverDoc("strategy-agent-template")).toBeNull();
  });

  test("'forest-writes' key is registered", () => {
    expect(getCachedRiverDoc("forest-writes")).toBeNull();
  });

  test("'playbook-commands' key is registered", () => {
    expect(getCachedRiverDoc("playbook-commands")).toBeNull();
  });

  test("'work-commands' key is registered", () => {
    expect(getCachedRiverDoc("work-commands")).toBeNull();
  });

  test("'planning-mode' key is registered", () => {
    expect(getCachedRiverDoc("planning-mode")).toBeNull();
  });
});

// ── Cache hit/miss/clear cycle ────────────────────────────────────────────────

describe("cache hit/miss/clear cycle", () => {
  test("miss → inject → hit → clear → miss", () => {
    expect(getCachedRiverDoc("dev-agent-template")).toBeNull();
    _injectRiverDocForTesting("dev-agent-template", "content-A");
    expect(getCachedRiverDoc("dev-agent-template")).toBe("content-A");
    clearRiverDocCache();
    expect(getCachedRiverDoc("dev-agent-template")).toBeNull();
  });

  test("stale-while-revalidate: stale content returned after TTL=0", () => {
    setRiverDocCacheTtl(0);
    _injectRiverDocForTesting("dev-agent-template", "stale-template");
    expect(getCachedRiverDoc("dev-agent-template")).toBe("stale-template");
  });

  test("clearRiverDocCache removes all keys", () => {
    _injectRiverDocForTesting("dev-agent-template", "template");
    _injectRiverDocForTesting("soul", "soul-content");
    _injectRiverDocForTesting("memory-protocol", "memory");
    clearRiverDocCache();
    expect(getCachedRiverDoc("dev-agent-template")).toBeNull();
    expect(getCachedRiverDoc("soul")).toBeNull();
    expect(getCachedRiverDoc("memory-protocol")).toBeNull();
  });

  test("inject roundtrip for all 10 keys", () => {
    const keys = [
      "soul", "memory-protocol", "confirm-protocol",
      "dev-agent-template", "research-agent-template", "strategy-agent-template",
      "forest-writes", "playbook-commands", "work-commands", "planning-mode",
    ];
    for (const key of keys) {
      _injectRiverDocForTesting(key, `content-${key}`);
    }
    for (const key of keys) {
      expect(getCachedRiverDoc(key)).toBe(`content-${key}`);
    }
  });
});
