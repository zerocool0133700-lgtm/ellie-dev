import { describe, it, expect, beforeEach } from "bun:test";
import { ShadowContextStore } from "../src/shadow-context-store.ts";

describe("ELLIE-1056: Shadow context store", () => {
  let store: ShadowContextStore;

  beforeEach(() => {
    store = new ShadowContextStore();
  });

  describe("store and expand", () => {
    it("stores and returns shadow ID", () => {
      const id = store.store({
        label: "soul",
        original: "Full soul content here...",
        compressed: "Compressed soul",
        originalTokens: 500,
        compressedTokens: 150,
      });
      expect(id).toMatch(/^shadow_/);
    });

    it("expands to original content", () => {
      const id = store.store({
        label: "soul",
        original: "Full soul content",
        compressed: "Short",
        originalTokens: 100,
        compressedTokens: 20,
      });
      const expanded = store.expand(id);
      expect(expanded).toBe("Full soul content");
    });

    it("returns null for unknown ID", () => {
      expect(store.expand("shadow_nonexistent")).toBeNull();
    });

    it("tracks expansion count", () => {
      const id = store.store({
        label: "test",
        original: "original",
        compressed: "short",
        originalTokens: 50,
        compressedTokens: 10,
      });
      store.expand(id);
      store.expand(id);
      expect(store.stats().expansions).toBe(2);
    });
  });

  describe("peek", () => {
    it("returns metadata without expanding", () => {
      const id = store.store({
        label: "archetype",
        original: "Full archetype",
        compressed: "Short",
        originalTokens: 200,
        compressedTokens: 60,
      });
      const meta = store.peek(id);
      expect(meta).not.toBeNull();
      expect(meta!.label).toBe("archetype");
      expect(meta!.originalTokens).toBe(200);
      // Peek should NOT increment expansions
      expect(store.stats().expansions).toBe(0);
    });
  });

  describe("list", () => {
    it("returns all active entries", () => {
      store.store({ label: "a", original: "aaa", compressed: "a", originalTokens: 30, compressedTokens: 10 });
      store.store({ label: "b", original: "bbb", compressed: "b", originalTokens: 40, compressedTokens: 15 });
      const list = store.list();
      expect(list.length).toBe(2);
      expect(list[0].label).toBe("a");
      expect(list[1].label).toBe("b");
    });
  });

  describe("stats", () => {
    it("tracks token totals", () => {
      store.store({ label: "a", original: "aaa", compressed: "a", originalTokens: 100, compressedTokens: 30 });
      store.store({ label: "b", original: "bbb", compressed: "b", originalTokens: 200, compressedTokens: 60 });
      const stats = store.stats();
      expect(stats.size).toBe(2);
      expect(stats.totalOriginalTokens).toBe(300);
      expect(stats.totalCompressedTokens).toBe(90);
    });
  });

  describe("TTL expiry", () => {
    it("returns null for expired entries on expand", () => {
      // Manually create an expired entry by accessing internals
      const id = store.store({
        label: "old",
        original: "old content",
        compressed: "old",
        originalTokens: 50,
        compressedTokens: 10,
      });
      // Hack: set createdAt to past
      const entries = (store as any).entries as Map<string, any>;
      const entry = entries.get(id)!;
      entry.createdAt = Date.now() - 6 * 60 * 60_000; // 6 hours ago (past 5h TTL)
      expect(store.expand(id)).toBeNull();
    });
  });
});
