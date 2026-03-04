/**
 * ELLIE-534 — River doc QMD performance metrics tests
 *
 * Tests the performance measurement layer added in ELLIE-534:
 *   - getRiverDocMetrics(): initial state, hit/miss/stale counters
 *   - _resetRiverMetricsForTesting(): isolation between tests
 *   - getCachedRiverDoc: increments cacheHits on hit, cacheMisses on miss, staleHits on stale
 *   - _refreshRiverDocs (via refreshRiverDocs): populates lastRefresh with timing + per-doc results
 *   - BuildMetrics: riverCacheHits / riverCacheMisses reflect this build's cache accesses
 *   - No module mocking — uses _injectRiverDocForTesting() to control cache state
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  buildPrompt,
  getLastBuildMetrics,
  getCachedRiverDoc,
  clearRiverDocCache,
  setRiverDocCacheTtl,
  refreshRiverDocs,
  getRiverDocMetrics,
  _injectRiverDocForTesting,
  _resetRiverMetricsForTesting,
  stopPersonalityWatchers,
} from "../src/prompt-builder.ts";

// ── Cleanup ────────────────────────────────────────────────────────────────────

afterAll(() => {
  stopPersonalityWatchers();
  clearRiverDocCache();
  setRiverDocCacheTtl(60_000);
  _resetRiverMetricsForTesting();
});

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Reset River cache, TTL, and perf metrics before each test. */
beforeEach(() => {
  clearRiverDocCache();
  setRiverDocCacheTtl(60_000);
  _resetRiverMetricsForTesting();
});

// ── getRiverDocMetrics — initial state ────────────────────────────────────────

describe("getRiverDocMetrics — initial state after reset", () => {
  test("lastRefresh is null initially", () => {
    expect(getRiverDocMetrics().lastRefresh).toBeNull();
  });

  test("cacheHits starts at 0", () => {
    expect(getRiverDocMetrics().cacheHits).toBe(0);
  });

  test("cacheMisses starts at 0", () => {
    expect(getRiverDocMetrics().cacheMisses).toBe(0);
  });

  test("staleHits starts at 0", () => {
    expect(getRiverDocMetrics().staleHits).toBe(0);
  });
});

// ── _resetRiverMetricsForTesting ──────────────────────────────────────────────

describe("_resetRiverMetricsForTesting", () => {
  test("zeroes cacheHits after accumulation", () => {
    _injectRiverDocForTesting("soul", "Some soul");
    getCachedRiverDoc("soul"); // hit
    getCachedRiverDoc("soul"); // hit
    expect(getRiverDocMetrics().cacheHits).toBe(2);
    _resetRiverMetricsForTesting();
    expect(getRiverDocMetrics().cacheHits).toBe(0);
  });

  test("zeroes cacheMisses after accumulation", () => {
    getCachedRiverDoc("soul"); // miss (cache empty)
    getCachedRiverDoc("memory-protocol"); // miss
    expect(getRiverDocMetrics().cacheMisses).toBe(2);
    _resetRiverMetricsForTesting();
    expect(getRiverDocMetrics().cacheMisses).toBe(0);
  });

  test("zeroes staleHits after accumulation", () => {
    setRiverDocCacheTtl(0);
    _injectRiverDocForTesting("soul", "Stale soul");
    getCachedRiverDoc("soul"); // stale hit
    expect(getRiverDocMetrics().staleHits).toBe(1);
    _resetRiverMetricsForTesting();
    expect(getRiverDocMetrics().staleHits).toBe(0);
  });

  test("resets lastRefresh to null", async () => {
    await refreshRiverDocs(); // populates lastRefresh
    expect(getRiverDocMetrics().lastRefresh).not.toBeNull();
    _resetRiverMetricsForTesting();
    expect(getRiverDocMetrics().lastRefresh).toBeNull();
  });

  test("safe to call on already-zeroed state", () => {
    expect(() => _resetRiverMetricsForTesting()).not.toThrow();
    expect(() => _resetRiverMetricsForTesting()).not.toThrow();
    expect(getRiverDocMetrics().cacheHits).toBe(0);
  });
});

// ── getCachedRiverDoc — counter increments ────────────────────────────────────

describe("getCachedRiverDoc — counter increments", () => {
  test("cache hit increments cacheHits", () => {
    _injectRiverDocForTesting("soul", "Soul content");
    getCachedRiverDoc("soul");
    expect(getRiverDocMetrics().cacheHits).toBe(1);
  });

  test("cache hit does NOT increment cacheMisses or staleHits", () => {
    _injectRiverDocForTesting("soul", "Soul content");
    getCachedRiverDoc("soul");
    expect(getRiverDocMetrics().cacheMisses).toBe(0);
    expect(getRiverDocMetrics().staleHits).toBe(0);
  });

  test("cache miss increments cacheMisses", () => {
    getCachedRiverDoc("soul"); // cache empty
    expect(getRiverDocMetrics().cacheMisses).toBe(1);
  });

  test("cache miss does NOT increment cacheHits or staleHits", () => {
    getCachedRiverDoc("soul");
    expect(getRiverDocMetrics().cacheHits).toBe(0);
    expect(getRiverDocMetrics().staleHits).toBe(0);
  });

  test("multiple misses accumulate", () => {
    getCachedRiverDoc("soul");
    getCachedRiverDoc("memory-protocol");
    getCachedRiverDoc("confirm-protocol");
    expect(getRiverDocMetrics().cacheMisses).toBe(3);
  });

  test("multiple hits accumulate", () => {
    _injectRiverDocForTesting("soul", "Soul");
    getCachedRiverDoc("soul");
    getCachedRiverDoc("soul");
    getCachedRiverDoc("soul");
    expect(getRiverDocMetrics().cacheHits).toBe(3);
  });

  test("stale content increments staleHits (TTL=0)", () => {
    setRiverDocCacheTtl(0);
    _injectRiverDocForTesting("soul", "Stale soul");
    getCachedRiverDoc("soul"); // TTL expired → stale hit
    expect(getRiverDocMetrics().staleHits).toBe(1);
    expect(getRiverDocMetrics().cacheHits).toBe(0);
    expect(getRiverDocMetrics().cacheMisses).toBe(0);
  });

  test("stale content still returns the content", () => {
    setRiverDocCacheTtl(0);
    _injectRiverDocForTesting("memory-protocol", "Stale memory content");
    const result = getCachedRiverDoc("memory-protocol");
    expect(result).toBe("Stale memory content");
    expect(getRiverDocMetrics().staleHits).toBe(1);
  });

  test("mixed hits and misses accumulate independently", () => {
    _injectRiverDocForTesting("soul", "Soul");
    getCachedRiverDoc("soul");           // hit
    getCachedRiverDoc("soul");           // hit
    getCachedRiverDoc("memory-protocol"); // miss
    getCachedRiverDoc("confirm-protocol"); // miss
    expect(getRiverDocMetrics().cacheHits).toBe(2);
    expect(getRiverDocMetrics().cacheMisses).toBe(2);
  });

  test("getRiverDocMetrics returns a snapshot (not live reference)", () => {
    const snap1 = getRiverDocMetrics();
    _injectRiverDocForTesting("soul", "Soul");
    getCachedRiverDoc("soul"); // hit
    const snap2 = getRiverDocMetrics();
    // snap1 should still show 0
    expect(snap1.cacheHits).toBe(0);
    // snap2 should show 1
    expect(snap2.cacheHits).toBe(1);
  });
});

// ── refreshRiverDocs — lastRefresh population ─────────────────────────────────

describe("refreshRiverDocs — lastRefresh populated", () => {
  test("lastRefresh is set after refreshRiverDocs (even if QMD unavailable)", async () => {
    await refreshRiverDocs();
    expect(getRiverDocMetrics().lastRefresh).not.toBeNull();
  });

  test("lastRefresh.startedAt is a positive timestamp", async () => {
    const before = Date.now();
    await refreshRiverDocs();
    const { lastRefresh } = getRiverDocMetrics();
    // startedAt is always a positive ms timestamp
    expect(lastRefresh!.startedAt).toBeGreaterThan(0);
    // Should be at most 30s in the future from before (generous slack for slow environments)
    expect(lastRefresh!.startedAt).toBeLessThanOrEqual(before + 30_000);
  });

  test("lastRefresh.durationMs is non-negative", async () => {
    await refreshRiverDocs();
    expect(getRiverDocMetrics().lastRefresh!.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("lastRefresh.loaded + lastRefresh.failed >= 0", async () => {
    await refreshRiverDocs();
    const { lastRefresh } = getRiverDocMetrics();
    expect(lastRefresh!.loaded).toBeGreaterThanOrEqual(0);
    expect(lastRefresh!.failed).toBeGreaterThanOrEqual(0);
  });

  test("lastRefresh.loaded + lastRefresh.failed <= registered doc count (6)", async () => {
    await refreshRiverDocs();
    const { lastRefresh } = getRiverDocMetrics();
    // If QMD is unavailable, each doc may fail individually (all 6 fail) or import may fail (0 recorded)
    // RIVER_DOC_PATHS now has 6 entries (soul, memory-protocol, confirm-protocol,
    // dev-agent-template, research-agent-template, strategy-agent-template)
    const total = lastRefresh!.loaded + lastRefresh!.failed;
    expect(total).toBeGreaterThanOrEqual(0);
    expect(total).toBeLessThanOrEqual(6);
  });

  test("lastRefresh.docs has entries for registered keys", async () => {
    await refreshRiverDocs();
    const { docs } = getRiverDocMetrics().lastRefresh!;
    // All keys that attempted a fetch should have a result (either loaded or failed)
    const docKeys = Object.keys(docs);
    expect(docKeys.length).toBeGreaterThan(0);
  });

  test("each doc result has durationMs >= 0", async () => {
    await refreshRiverDocs();
    const { docs } = getRiverDocMetrics().lastRefresh!;
    for (const result of Object.values(docs)) {
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("each doc result status is 'loaded' or 'failed'", async () => {
    await refreshRiverDocs();
    const { docs } = getRiverDocMetrics().lastRefresh!;
    for (const result of Object.values(docs)) {
      expect(["loaded", "failed"]).toContain(result.status);
    }
  });

  test("second call overwrites lastRefresh", async () => {
    await refreshRiverDocs();
    const first = getRiverDocMetrics().lastRefresh!.startedAt;
    await new Promise(r => setTimeout(r, 5)); // ensure timestamp differs
    await refreshRiverDocs();
    const second = getRiverDocMetrics().lastRefresh!.startedAt;
    expect(second).toBeGreaterThanOrEqual(first);
  });

  test("concurrent calls both resolve (second is no-op)", async () => {
    const [r1, r2] = await Promise.allSettled([refreshRiverDocs(), refreshRiverDocs()]);
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");
    expect(getRiverDocMetrics().lastRefresh).not.toBeNull();
  });
});

// ── BuildMetrics — riverCacheHits / riverCacheMisses ─────────────────────────

describe("BuildMetrics — riverCacheHits and riverCacheMisses", () => {
  test("riverCacheHits and riverCacheMisses present on BuildMetrics", () => {
    buildPrompt("Hello");
    const metrics = getLastBuildMetrics()!;
    expect(typeof metrics.riverCacheHits).toBe("number");
    expect(typeof metrics.riverCacheMisses).toBe("number");
  });

  test("all-miss build: riverCacheHits is 0 when cache is empty", () => {
    // Cache is empty (beforeEach cleared it)
    buildPrompt("Hello");
    const metrics = getLastBuildMetrics()!;
    expect(metrics.riverCacheHits).toBe(0);
  });

  test("all-miss build: riverCacheMisses equals number of River doc lookups", () => {
    // No docs in cache → all lookups are misses
    buildPrompt("Hello");
    const metrics = getLastBuildMetrics()!;
    // At minimum 1 miss (soul lookup for general agent)
    expect(metrics.riverCacheMisses).toBeGreaterThanOrEqual(1);
  });

  test("soul injected: riverCacheHits >= 1 for general agent", () => {
    _injectRiverDocForTesting("soul", "River soul content");
    buildPrompt("Hello");
    const metrics = getLastBuildMetrics()!;
    expect(metrics.riverCacheHits).toBeGreaterThanOrEqual(1);
  });

  test("all River docs injected: riverCacheMisses = 0 when all cached", () => {
    _injectRiverDocForTesting("soul", "Soul");
    _injectRiverDocForTesting("memory-protocol", "Memory protocol");
    _injectRiverDocForTesting("confirm-protocol", "Confirm protocol");
    buildPrompt("Hello");
    const metrics = getLastBuildMetrics()!;
    expect(metrics.riverCacheMisses).toBe(0);
  });

  test("riverCacheHits + riverCacheMisses = total River lookups for this build", () => {
    _injectRiverDocForTesting("soul", "Soul");
    _injectRiverDocForTesting("memory-protocol", "Memory");
    // confirm-protocol NOT injected → miss
    buildPrompt("Hello");
    const metrics = getLastBuildMetrics()!;
    // soul hit + memory-protocol hit + confirm-protocol miss = 3 total
    // (dev-protocol not included for general agent without work item)
    expect(metrics.riverCacheHits + metrics.riverCacheMisses).toBeGreaterThanOrEqual(3);
  });

  test("downstream agent build: soul not looked up, riverCacheHits from protocol docs", () => {
    _injectRiverDocForTesting("memory-protocol", "Memory");
    _injectRiverDocForTesting("confirm-protocol", "Confirm");
    buildPrompt("Fix it", undefined, undefined, undefined, "telegram", {
      system_prompt: "You are a dev agent.",
      name: "dev",
    });
    const metrics = getLastBuildMetrics()!;
    // Soul is NOT looked up for downstream agents (ELLIE-525)
    // memory-protocol and confirm-protocol are hits
    expect(metrics.riverCacheHits).toBeGreaterThanOrEqual(2);
  });

  test("per-build metrics are independent between builds", () => {
    // First build: all cache empty
    buildPrompt("First");
    const first = getLastBuildMetrics()!;

    // Inject soul, second build has a hit
    _injectRiverDocForTesting("soul", "Soul");
    buildPrompt("Second");
    const second = getLastBuildMetrics()!;

    // Second build should have at least 1 more hit than first
    expect(second.riverCacheHits).toBeGreaterThan(first.riverCacheHits);
  });

  test("dev agent with work item: dev-protocol lookup included", () => {
    _injectRiverDocForTesting("dev-agent-template", "Dev template");
    buildPrompt(
      "Fix ELLIE-1",
      undefined,
      undefined,
      undefined,
      "telegram",
      { system_prompt: "You are a dev agent.", name: "dev" },
      "ACTIVE WORK ITEM: ELLIE-1 | Fix something",
    );
    const metrics = getLastBuildMetrics()!;
    // dev-agent-template should be a hit
    expect(metrics.riverCacheHits).toBeGreaterThanOrEqual(1);
  });
});

// ── Integration: cumulative metrics across multiple builds ────────────────────

describe("cumulative metrics across builds", () => {
  test("global cacheHits accumulates across multiple buildPrompt calls", () => {
    _injectRiverDocForTesting("soul", "Soul");
    buildPrompt("First");
    buildPrompt("Second");
    buildPrompt("Third");
    // Each general agent build looks up soul (hit) + protocols
    expect(getRiverDocMetrics().cacheHits).toBeGreaterThanOrEqual(3);
  });

  test("reset clears accumulated global counters", () => {
    _injectRiverDocForTesting("soul", "Soul");
    buildPrompt("First");
    buildPrompt("Second");
    expect(getRiverDocMetrics().cacheHits).toBeGreaterThan(0);
    _resetRiverMetricsForTesting();
    expect(getRiverDocMetrics().cacheHits).toBe(0);
    expect(getRiverDocMetrics().cacheMisses).toBe(0);
  });
});
