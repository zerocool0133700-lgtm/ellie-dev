import { describe, it, expect } from "bun:test";
import { contentHash, normalizeForHash } from "../src/ums/content-hash.ts";

describe("ELLIE-1031: Content hash deduplication", () => {
  describe("normalizeForHash", () => {
    it("lowercases text", () => {
      expect(normalizeForHash("Dave Prefers Async")).toBe("dave prefers async");
    });

    it("trims whitespace", () => {
      expect(normalizeForHash("  hello world  ")).toBe("hello world");
    });

    it("collapses internal whitespace", () => {
      expect(normalizeForHash("hello   world")).toBe("hello world");
    });

    it("handles newlines and tabs", () => {
      expect(normalizeForHash("hello\n\tworld")).toBe("hello world");
    });
  });

  describe("contentHash", () => {
    it("returns consistent hash for same content", () => {
      const h1 = contentHash("Dave prefers async decisions");
      const h2 = contentHash("Dave prefers async decisions");
      expect(h1).toBe(h2);
    });

    it("returns same hash regardless of whitespace/case", () => {
      const h1 = contentHash("Dave prefers async");
      const h2 = contentHash("  DAVE   PREFERS   ASYNC  ");
      expect(h1).toBe(h2);
    });

    it("returns different hash for different content", () => {
      const h1 = contentHash("Dave prefers async");
      const h2 = contentHash("Dave prefers sync");
      expect(h1).not.toBe(h2);
    });

    it("returns 64-char hex string (SHA256)", () => {
      const hash = contentHash("test");
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});
