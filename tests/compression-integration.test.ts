import { describe, it, expect } from "bun:test";
import { compressSection, compressSections, COMPRESS_MIN_PRIORITY, SUPPRESS_PRIORITY } from "../src/section-compressor.ts";
import { CompressionCache } from "../src/compression-cache.ts";
import { ShadowContextStore } from "../src/shadow-context-store.ts";
import { estimateTokens } from "../src/relay-utils.ts";

describe("Compression pipeline integration", () => {
  describe("compressSection — full pipeline", () => {
    it("includes low-priority sections unchanged", async () => {
      const result = await compressSection("soul", "This is the soul content for testing", 2);
      expect(result.compressed).toBe(false);
      expect(result.content).toBe("This is the soul content for testing");
      expect(result.action).toBeUndefined(); // Not compressed
    });

    it("suppresses priority 9 sections", async () => {
      const result = await compressSection("health", "Lots of health data here", 9);
      expect(result.content).toBe("");
      expect(result.originalTokens).toBeGreaterThan(0);
    });

    it("skips compression for small sections even at priority 7", async () => {
      const result = await compressSection("tiny-section", "Short text", 7);
      expect(result.compressed).toBe(false);
      expect(result.content).toBe("Short text");
    });

    it("preserves token count for included sections", async () => {
      const content = "Test content for token counting";
      const result = await compressSection("test", content, 3);
      expect(result.originalTokens).toBe(estimateTokens(content));
    });
  });

  describe("compressSections — budget-aware batch", () => {
    const sections = [
      { label: "soul", content: "Soul content", priority: 2 },
      { label: "archetype", content: "Archetype content", priority: 3 },
      { label: "conversation", content: "Recent conversation history", priority: 5 },
      { label: "queue", content: "Queue status data", priority: 8 },
      { label: "health", content: "Health data", priority: 9 },
    ];

    it("returns all sections when under budget", async () => {
      const result = await compressSections(sections, 100_000);
      expect(result.metrics.sectionsCompressed).toBe(0);
      expect(result.metrics.tokensSaved).toBe(0);
    });

    it("returns metrics structure", async () => {
      const result = await compressSections(sections, 100_000);
      expect(result.metrics).toHaveProperty("totalOriginalTokens");
      expect(result.metrics).toHaveProperty("totalCompressedTokens");
      expect(result.metrics).toHaveProperty("sectionsCompressed");
      expect(result.metrics).toHaveProperty("sectionsSuppressed");
      expect(result.metrics).toHaveProperty("tokensSaved");
    });
  });

  describe("CompressionCache — end to end", () => {
    it("caches and retrieves compression results", () => {
      const cache = new CompressionCache({ maxEntries: 10, ttlMs: 60_000 });
      const key = CompressionCache.cacheKey("test content", 0.3);

      cache.set(key, {
        compressed: "short",
        originalTokens: 100,
        compressedTokens: 30,
        ratio: 0.7,
        cachedAt: Date.now(),
      });

      const retrieved = cache.get(key);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.compressed).toBe("short");
      expect(cache.stats().hits).toBe(1);
    });
  });

  describe("ShadowContextStore — end to end", () => {
    it("stores, expands, and tracks metrics", () => {
      const store = new ShadowContextStore();

      const id = store.store({
        label: "soul",
        original: "Full soul content with lots of detail",
        compressed: "Soul summary",
        originalTokens: 500,
        compressedTokens: 100,
      });

      expect(id).toMatch(/^shadow_/);

      const expanded = store.expand(id);
      expect(expanded).toBe("Full soul content with lots of detail");

      const stats = store.stats();
      expect(stats.stores).toBe(1);
      expect(stats.expansions).toBe(1);
      expect(stats.totalOriginalTokens).toBe(500);
    });
  });

  describe("Tool output — TOON encoding pipeline", () => {
    it("encodes JSON arrays and creates shadow entry", async () => {
      const { tryToonEncoding } = await import("../src/tool-output-compressor.ts");
      const input = JSON.stringify([
        { name: "Alice", role: "dev", status: "active" },
        { name: "Bob", role: "ops", status: "active" },
        { name: "Carol", role: "research", status: "idle" },
      ]);
      const result = tryToonEncoding(input);
      expect(result).not.toBeNull();
      expect(result).toContain("[3 items]");
      expect(result).toContain("name | role | status");
    });
  });

  describe("Tool discovery — filtering pipeline", () => {
    it("filters 18 tools down to subset for dev archetype", async () => {
      const { filterTools } = await import("../src/tool-discovery-filter.ts");
      const allTools = Array.from({ length: 18 }, (_, i) => ({
        name: `tool_${i}`,
        description: `Tool ${i}`,
      }));
      // Add core tools
      allTools[0].name = "Bash";
      allTools[1].name = "Read";
      allTools[2].name = "Edit";

      const result = filterTools(allTools, { archetype: "dev", message: "fix the bug" });
      expect(result.included.length).toBeLessThan(18);
      expect(result.deferred.length).toBeGreaterThan(0);
      expect(result.tokensSaved).toBeGreaterThan(0);
    });
  });

  describe("Preemptive summarization — trigger logic", () => {
    it("triggers at 80% and skips below", async () => {
      const { shouldTrigger } = await import("../src/preemptive-summarizer.ts");
      expect(shouldTrigger(85_000, 100_000)).toBe(true);
      expect(shouldTrigger(50_000, 100_000)).toBe(false);
      expect(shouldTrigger(79_999, 100_000)).toBe(false);
      expect(shouldTrigger(80_000, 100_000)).toBe(true);
    });
  });
});
