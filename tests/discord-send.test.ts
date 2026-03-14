/**
 * Channel Tests: Discord Send — ELLIE-711
 *
 * Tests text chunking and webhook URL management.
 */

import { describe, test, expect, mock } from "bun:test";

// ── Mocks ─────────────────────────────────────────────────────
mock.module("discord.js", () => ({
  EmbedBuilder: class {
    setDescription() { return this; }
    setColor() { return this; }
    setTimestamp() { return this; }
  },
}));
mock.module("../../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

import { chunkText, getWebhookUrl, initWebhooks } from "../src/channels/discord/send.ts";

describe("discord send", () => {
  describe("chunkText", () => {
    test("returns single chunk for short text", () => {
      const chunks = chunkText("Hello world");
      expect(chunks).toEqual(["Hello world"]);
    });

    test("returns single chunk at exactly 1990 chars", () => {
      const text = "a".repeat(1990);
      expect(chunkText(text)).toEqual([text]);
    });

    test("splits long text into multiple chunks", () => {
      const text = "a".repeat(4000);
      const chunks = chunkText(text);
      expect(chunks.length).toBeGreaterThan(1);
      // All chunks should be <= 1990
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(1990);
      }
    });

    test("prefers breaking at newlines", () => {
      // 1500 chars then newline then 500 chars = 2001 total
      const line1 = "a".repeat(1500);
      const line2 = "b".repeat(500);
      const text = `${line1}\n${line2}`;
      const chunks = chunkText(text);
      expect(chunks.length).toBe(2);
      expect(chunks[0]).toBe(line1);
      expect(chunks[1]).toBe(line2);
    });

    test("handles text with no newlines", () => {
      const text = "a".repeat(3000);
      const chunks = chunkText(text);
      expect(chunks.length).toBe(2);
      expect(chunks[0].length).toBe(1990);
    });

    test("handles empty string", () => {
      expect(chunkText("")).toEqual([""]);
    });

    test("reconstructs to original content", () => {
      const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}: ${"x".repeat(80)}`);
      const text = lines.join("\n");
      const chunks = chunkText(text);
      const reconstructed = chunks.join("\n");
      // Content should be preserved (trimming between chunks may remove some whitespace)
      expect(reconstructed.replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
    });
  });

  describe("getWebhookUrl", () => {
    test("returns undefined for unconfigured agent", () => {
      expect(getWebhookUrl("nonexistent")).toBeUndefined();
    });
  });
});
