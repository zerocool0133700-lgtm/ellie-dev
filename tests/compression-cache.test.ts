import { describe, it, expect, beforeEach } from "bun:test";
import { CompressionCache } from "../src/compression-cache.ts";

describe("ELLIE-1062: Compression cache", () => {
  let cache: CompressionCache;

  beforeEach(() => {
    cache = new CompressionCache({ maxEntries: 5, ttlMs: 1000 });
  });

  describe("cacheKey", () => {
    it("generates consistent keys for same input", () => {
      const k1 = CompressionCache.cacheKey("hello world", 0.3);
      const k2 = CompressionCache.cacheKey("hello world", 0.3);
      expect(k1).toBe(k2);
    });

    it("generates different keys for different ratios", () => {
      const k1 = CompressionCache.cacheKey("hello", 0.3);
      const k2 = CompressionCache.cacheKey("hello", 0.5);
      expect(k1).not.toBe(k2);
    });

    it("generates different keys for different content", () => {
      const k1 = CompressionCache.cacheKey("hello", 0.3);
      const k2 = CompressionCache.cacheKey("world", 0.3);
      expect(k1).not.toBe(k2);
    });

    it("returns 24-char hex string", () => {
      const key = CompressionCache.cacheKey("test", 0.5);
      expect(key).toMatch(/^[a-f0-9]{24}$/);
    });
  });

  describe("get/set", () => {
    const entry = {
      compressed: "short version",
      originalTokens: 1000,
      compressedTokens: 300,
      ratio: 0.7,
      cachedAt: Date.now(),
    };

    it("returns null on cache miss", () => {
      expect(cache.get("nonexistent")).toBeNull();
    });

    it("returns entry on cache hit", () => {
      cache.set("key1", entry);
      const result = cache.get("key1");
      expect(result).not.toBeNull();
      expect(result!.compressed).toBe("short version");
    });

    it("tracks hits and misses", () => {
      cache.set("key1", entry);
      cache.get("key1"); // hit
      cache.get("key2"); // miss
      const stats = cache.stats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBe(0.5);
    });
  });

  describe("LRU eviction", () => {
    it("evicts oldest entry when at capacity", () => {
      for (let i = 0; i < 5; i++) {
        cache.set(`key${i}`, {
          compressed: `v${i}`,
          originalTokens: 100,
          compressedTokens: 30,
          ratio: 0.7,
          cachedAt: Date.now(),
        });
      }
      // Cache is full (5 entries). Add one more.
      cache.set("key5", {
        compressed: "v5",
        originalTokens: 100,
        compressedTokens: 30,
        ratio: 0.7,
        cachedAt: Date.now(),
      });
      // key0 should be evicted
      expect(cache.get("key0")).toBeNull();
      expect(cache.get("key5")).not.toBeNull();
    });
  });

  describe("TTL expiry", () => {
    it("returns null for expired entries", async () => {
      const shortCache = new CompressionCache({ maxEntries: 10, ttlMs: 50 });
      shortCache.set("key1", {
        compressed: "old",
        originalTokens: 100,
        compressedTokens: 30,
        ratio: 0.7,
        cachedAt: Date.now() - 100, // already expired
      });
      expect(shortCache.get("key1")).toBeNull();
    });
  });

  describe("shouldBypass", () => {
    it("bypasses time-sensitive sections", () => {
      expect(cache.shouldBypass("conversation")).toBe(true);
      expect(cache.shouldBypass("work-item")).toBe(true);
      expect(cache.shouldBypass("queue")).toBe(true);
    });

    it("does not bypass static sections", () => {
      expect(cache.shouldBypass("soul")).toBe(false);
      expect(cache.shouldBypass("archetype")).toBe(false);
      expect(cache.shouldBypass("skills")).toBe(false);
    });
  });

  describe("clear", () => {
    it("empties the cache", () => {
      cache.set("key1", {
        compressed: "x",
        originalTokens: 10,
        compressedTokens: 3,
        ratio: 0.7,
        cachedAt: Date.now(),
      });
      cache.clear();
      expect(cache.stats().size).toBe(0);
      expect(cache.get("key1")).toBeNull();
    });
  });
});
