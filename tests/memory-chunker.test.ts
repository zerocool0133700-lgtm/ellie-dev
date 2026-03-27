import { describe, it, expect } from "bun:test";
import { chunkContent, MAX_CHUNK_TOKENS, MIN_CHUNK_TOKENS, CHARS_PER_TOKEN } from "../../ellie-forest/src/memory-chunker.ts";

describe("ELLIE-1050: Memory chunker", () => {
  describe("chunkContent", () => {
    it("returns single chunk for short content", () => {
      const chunks = chunkContent("Short content here.");
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe("Short content here.");
    });

    it("returns empty for empty content", () => {
      expect(chunkContent("")).toEqual([]);
      expect(chunkContent("   ")).toEqual([]);
    });

    it("splits on heading boundaries", () => {
      // Each section needs to be >= MIN_CHUNK_TOKENS * CHARS_PER_TOKEN (200 chars)
      const sectionBody = "This is detailed content that fills out the section with enough text to pass the minimum chunk threshold. ".repeat(3);
      const content = `## Section A\n${sectionBody}\n\n## Section B\n${sectionBody}\n\n## Section C\n${sectionBody}`;
      const chunks = chunkContent(content, 200);
      expect(chunks.length).toBeGreaterThan(1);
    });

    it("splits on paragraph boundaries when no headings", () => {
      // Each paragraph group needs to be >= 200 chars after joining
      const paragraphs = Array.from({ length: 20 }, (_, i) =>
        `Paragraph ${i} with enough content to ensure each chunk passes the minimum size filter when grouped together by the chunker.`
      );
      const content = paragraphs.join("\n\n");
      const chunks = chunkContent(content, 200);
      expect(chunks.length).toBeGreaterThan(1);
    });

    it("respects max token limit", () => {
      const maxChars = 100 * CHARS_PER_TOKEN;
      const content = "x".repeat(maxChars * 3);
      const chunks = chunkContent(content, 100);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(maxChars + 50); // small tolerance
      }
    });

    it("filters out tiny chunks", () => {
      const minChars = MIN_CHUNK_TOKENS * CHARS_PER_TOKEN;
      const content = "## Big Section\n" + "x ".repeat(500) + "\n\n## Tiny\nHi";
      const chunks = chunkContent(content, 200);
      for (const chunk of chunks) {
        expect(chunk.length).toBeGreaterThanOrEqual(minChars);
      }
    });
  });

  describe("constants", () => {
    it("has sensible defaults", () => {
      expect(MAX_CHUNK_TOKENS).toBe(500);
      expect(MIN_CHUNK_TOKENS).toBe(50);
      expect(CHARS_PER_TOKEN).toBe(4);
    });
  });

  describe("module exports", () => {
    it("exports required functions", async () => {
      const mod = await import("../../ellie-forest/src/memory-chunker.ts");
      expect(typeof mod.chunkContent).toBe("function");
      expect(typeof mod.chunkAndEmbedMemory).toBe("function");
      expect(typeof mod.searchChunks).toBe("function");
      expect(typeof mod.removeChunks).toBe("function");
    });
  });
});
