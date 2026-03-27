import { describe, it, expect } from "bun:test";
import {
  MIN_TOKENS_THRESHOLD,
  MAX_TOKENS_THRESHOLD,
  TARGET_RATIO,
  shouldCompress,
  tryToonEncoding,
} from "../src/tool-output-compressor.ts";

describe("ELLIE-1057: Tool output compression", () => {
  describe("shouldCompress", () => {
    it("returns false for short output", () => {
      expect(shouldCompress("hello world")).toBe(false);
    });

    it("returns true for output above threshold", () => {
      const longOutput = "x ".repeat(1000); // ~500 tokens
      expect(shouldCompress(longOutput)).toBe(true);
    });
  });

  describe("tryToonEncoding", () => {
    it("encodes uniform JSON arrays", () => {
      const input = JSON.stringify([
        { name: "Alice", age: 30, role: "dev" },
        { name: "Bob", age: 25, role: "ops" },
        { name: "Carol", age: 35, role: "research" },
      ]);
      const result = tryToonEncoding(input);
      expect(result).not.toBeNull();
      expect(result).toContain("[3 items]");
      expect(result).toContain("name | age | role");
      expect(result).toContain("Alice");
    });

    it("returns null for non-JSON", () => {
      expect(tryToonEncoding("not json")).toBeNull();
    });

    it("returns null for non-array JSON", () => {
      expect(tryToonEncoding('{"key": "value"}')).toBeNull();
    });

    it("returns null for arrays with fewer than 3 items", () => {
      expect(tryToonEncoding('[{"a":1},{"a":2}]')).toBeNull();
    });

    it("returns null for arrays with mixed keys", () => {
      const input = JSON.stringify([
        { name: "Alice", age: 30 },
        { name: "Bob", role: "ops" },
      ]);
      expect(tryToonEncoding(input)).toBeNull();
    });
  });

  describe("constants", () => {
    it("min threshold is 512 tokens", () => {
      expect(MIN_TOKENS_THRESHOLD).toBe(512);
    });

    it("max threshold is 50k tokens", () => {
      expect(MAX_TOKENS_THRESHOLD).toBe(50_000);
    });

    it("target ratio is 0.25", () => {
      expect(TARGET_RATIO).toBe(0.25);
    });
  });

  describe("metrics structure", () => {
    it("has expected shape", async () => {
      const { getToolCompressionMetrics } = await import("../src/tool-output-compressor.ts");
      const metrics = getToolCompressionMetrics();
      expect(metrics).toHaveProperty("totalCompressed");
      expect(metrics).toHaveProperty("totalPassthrough");
      expect(metrics).toHaveProperty("totalTokensSaved");
      expect(metrics).toHaveProperty("cacheStats");
      expect(metrics).toHaveProperty("shadowStats");
    });
  });
});
