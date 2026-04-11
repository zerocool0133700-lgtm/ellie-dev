import { describe, test, expect } from "bun:test";
import { chunkMarkdown, estimateTokens } from "../src/markdown-chunker";

describe("estimateTokens", () => {
  test("returns roughly chars/4", () => {
    expect(estimateTokens("hello world")).toBe(Math.ceil(11 / 4));
    expect(estimateTokens("")).toBe(0);
  });
});

describe("chunkMarkdown", () => {
  test("empty input returns empty array", () => {
    expect(chunkMarkdown("")).toEqual([]);
  });

  test("single short paragraph returns one chunk", () => {
    const md = "This is a single short paragraph that fits in one chunk.";
    const chunks = chunkMarkdown(md, 500);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(md);
  });

  test("multiple short paragraphs that fit return one chunk", () => {
    const md = "Para one.\n\nPara two.\n\nPara three.";
    const chunks = chunkMarkdown(md, 500);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("Para one");
    expect(chunks[0]).toContain("Para three");
  });

  test("paragraphs that exceed target split at paragraph boundaries", () => {
    const p = "x".repeat(600);
    const md = `${p}\n\n${p}\n\n${p}`;
    const chunks = chunkMarkdown(md, 200);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      const xCount = (c.match(/x/g) || []).length;
      expect(xCount % 600).toBe(0);
    }
  });

  test("single huge paragraph falls back to sentence splitting", () => {
    const sentence = "x".repeat(800) + ".";
    const md = `${sentence} ${sentence} ${sentence} ${sentence} ${sentence}`;
    const chunks = chunkMarkdown(md, 200);
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("mixed: short + huge + short — sentence-split does not bleed across paragraphs", () => {
    const shortBefore = "Short paragraph before.";
    const huge = "x".repeat(800) + ". " + "y".repeat(800) + ".";
    const shortAfter = "Short paragraph after.";
    const md = `${shortBefore}\n\n${huge}\n\n${shortAfter}`;
    const chunks = chunkMarkdown(md, 200);
    const afterChunks = chunks.filter(c => c.includes("Short paragraph after"));
    expect(afterChunks.length).toBeGreaterThan(0);
    for (const c of afterChunks) {
      expect(c.includes("xxxxx")).toBe(false);
      expect(c.includes("yyyyy")).toBe(false);
    }
  });
});
