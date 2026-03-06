/**
 * Tests for ELLIE-627: Reduce historical context injection limits
 *
 * Covers:
 *   - getMaxMemoriesForModel() — agent memory caps
 *   - getRecentConversations() — conversation summary caps
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";

import {
  getMaxMemoriesForModel,
  getRecentConversations,
} from "../src/context-sources";

// ── getMaxMemoriesForModel ──────────────────────────────────────────────────

describe("getMaxMemoriesForModel", () => {
  it("caps default (no model) at 5", () => {
    expect(getMaxMemoriesForModel()).toBe(5);
    expect(getMaxMemoriesForModel(null)).toBe(5);
    expect(getMaxMemoriesForModel(undefined)).toBe(5);
  });

  it("caps haiku at 3", () => {
    expect(getMaxMemoriesForModel("claude-haiku-4-5-20251001")).toBe(3);
    expect(getMaxMemoriesForModel("claude-3-haiku-20240307")).toBe(3);
  });

  it("caps sonnet at 5", () => {
    expect(getMaxMemoriesForModel("claude-sonnet-4-6")).toBe(5);
    expect(getMaxMemoriesForModel("claude-3-5-sonnet-20241022")).toBe(5);
  });

  it("caps opus at 5", () => {
    expect(getMaxMemoriesForModel("claude-opus-4-6")).toBe(5);
    expect(getMaxMemoriesForModel("claude-3-opus-20240229")).toBe(5);
  });

  it("never returns more than 5", () => {
    const models = [
      null, undefined, "",
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "some-unknown-model",
    ];
    for (const m of models) {
      expect(getMaxMemoriesForModel(m as any)).toBeLessThanOrEqual(5);
    }
  });
});

// ── getRecentConversations ──────────────────────────────────────────────────

describe("getRecentConversations", () => {
  it("returns empty string when supabase is null", async () => {
    const result = await getRecentConversations(null);
    expect(result).toBe("");
  });

  it("returns at most 3 conversation summaries", async () => {
    const conversations = Array.from({ length: 8 }, (_, i) => ({
      channel: "telegram",
      started_at: new Date(Date.now() - i * 3600_000).toISOString(),
      summary: `Conversation ${i + 1} summary`,
      message_count: 10 + i,
      status: "closed",
      agent: "general",
    }));

    let capturedLimit: number | undefined;
    const mockSupabase = {
      from: () => ({
        select: () => ({
          gte: () => ({
            order: () => ({
              limit: (n: number) => {
                capturedLimit = n;
                return Promise.resolve({
                  data: conversations.slice(0, n),
                  error: null,
                });
              },
            }),
          }),
        }),
      }),
    };

    const result = await getRecentConversations(mockSupabase as any);

    // Verify the limit passed to Supabase is 3
    expect(capturedLimit).toBe(3);

    // Verify we get exactly 3 conversation entries in the output
    const lines = result.split("\n").filter((l: string) => l.startsWith("- ["));
    expect(lines.length).toBe(3);
  });

  it("returns fewer than 3 when not enough conversations exist", async () => {
    const conversations = [
      {
        channel: "telegram",
        started_at: new Date().toISOString(),
        summary: "Only one conversation",
        message_count: 5,
        status: "closed",
        agent: null,
      },
    ];

    const mockSupabase = {
      from: () => ({
        select: () => ({
          gte: () => ({
            order: () => ({
              limit: (n: number) =>
                Promise.resolve({ data: conversations, error: null }),
            }),
          }),
        }),
      }),
    };

    const result = await getRecentConversations(mockSupabase as any);
    const lines = result.split("\n").filter((l: string) => l.startsWith("- ["));
    expect(lines.length).toBe(1);
  });

  it("returns empty string on query error", async () => {
    const mockSupabase = {
      from: () => ({
        select: () => ({
          gte: () => ({
            order: () => ({
              limit: () =>
                Promise.resolve({ data: null, error: { message: "DB error" } }),
            }),
          }),
        }),
      }),
    };

    const result = await getRecentConversations(mockSupabase as any);
    expect(result).toBe("");
  });

  it("output starts with RECENT CONVERSATIONS header", async () => {
    const mockSupabase = {
      from: () => ({
        select: () => ({
          gte: () => ({
            order: () => ({
              limit: () =>
                Promise.resolve({
                  data: [{
                    channel: "telegram",
                    started_at: new Date().toISOString(),
                    summary: "Test summary",
                    message_count: 3,
                    status: "closed",
                    agent: null,
                  }],
                  error: null,
                }),
            }),
          }),
        }),
      }),
    };

    const result = await getRecentConversations(mockSupabase as any);
    expect(result).toStartWith("RECENT CONVERSATIONS:");
  });
});
