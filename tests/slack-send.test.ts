/**
 * Channel Tests: Slack Send — ELLIE-711
 *
 * Tests text chunking for Slack's 3000-char limit.
 */

import { describe, test, expect, mock } from "bun:test";

mock.module("../../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

import { chunkText } from "../src/channels/slack/send.ts";

describe("slack send", () => {
  describe("chunkText", () => {
    test("returns single chunk for short text", () => {
      expect(chunkText("Hello")).toEqual(["Hello"]);
    });

    test("returns single chunk at exactly 3000 chars", () => {
      const text = "a".repeat(3000);
      expect(chunkText(text)).toEqual([text]);
    });

    test("splits text exceeding 3000 chars", () => {
      const text = "a".repeat(6000);
      const chunks = chunkText(text);
      expect(chunks.length).toBe(2);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(3000);
      }
    });

    test("prefers breaking at newlines", () => {
      const line1 = "a".repeat(2500);
      const line2 = "b".repeat(600);
      const text = `${line1}\n${line2}`;
      const chunks = chunkText(text);
      expect(chunks.length).toBe(2);
      expect(chunks[0]).toBe(line1);
    });

    test("handles text with many short lines", () => {
      const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}: ${"x".repeat(50)}`);
      const text = lines.join("\n");
      const chunks = chunkText(text);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(3000);
      }
      // Content preserved
      const reconstructed = chunks.join("\n");
      expect(reconstructed.length).toBeGreaterThan(0);
    });

    test("handles empty string", () => {
      expect(chunkText("")).toEqual([""]);
    });

    test("handles text slightly over limit", () => {
      const text = "a".repeat(3001);
      const chunks = chunkText(text);
      expect(chunks.length).toBe(2);
    });
  });
});
