/**
 * Integration tests for promoteToRiver wiring — ELLIE-612
 *
 * Covers: promoteToRiver() in conversations.ts — the function that queries
 * Supabase for conversation + memories, calls buildRiverDocument(), and
 * writes the result to the River bridge API.
 *
 * Uses a mock Supabase client and mock fetch to verify wiring without I/O.
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { promoteToRiver } from "../src/conversations";
import type { SupabaseClient } from "@supabase/supabase-js";

// ── Mock Helpers ─────────────────────────────────────────────────────────────

/** Build a mock Supabase client that returns preconfigured data. */
function mockSupabase(opts: {
  conversation?: Record<string, unknown> | null;
  memories?: Array<{ type: string; content: string }>;
}): SupabaseClient {
  const convoResult = opts.conversation === null
    ? { data: null, error: null }
    : { data: opts.conversation ?? null, error: null };

  const memoryResult = {
    data: opts.memories ?? [],
    error: null,
  };

  // Build chainable query mock for conversations table
  const convoChain = {
    select: () => convoChain,
    eq: () => convoChain,
    single: () => Promise.resolve(convoResult),
  };

  // Build chainable query mock for memory table
  const memoryChain = {
    select: () => memoryChain,
    eq: () => memoryChain,
    in: () => Promise.resolve(memoryResult),
  };

  return {
    from: (table: string) => {
      if (table === "conversations") return convoChain;
      if (table === "memory") return memoryChain;
      return convoChain; // fallback
    },
  } as unknown as SupabaseClient;
}

function makeConversation(overrides?: Record<string, unknown>) {
  return {
    id: "conv-test-001",
    channel: "telegram",
    agent: "dev",
    summary: "Discussed feature implementation for ELLIE-612.",
    message_count: 12,
    started_at: "2026-03-06T10:00:00Z",
    ended_at: "2026-03-06T11:00:00Z",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("promoteToRiver", () => {
  let fetchCalls: Array<{ url: string; body: Record<string, unknown> }>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchCalls = [];
    // Mock global fetch to capture River bridge API calls
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/bridge/river/write")) {
        const body = JSON.parse(init?.body as string);
        fetchCalls.push({ url, body });
        return new Response("OK", { status: 200 });
      }
      // Unexpected fetch — fail loud
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;
  });

  // Restore original fetch after all tests (safety net)
  // Note: bun:test doesn't have afterAll in the same scope, but
  // beforeEach resets the mock each run anyway.

  it("writes a River document on successful conversation close", async () => {
    const sb = mockSupabase({
      conversation: makeConversation(),
      memories: [
        { type: "fact", content: "River promoter handles conversation close" },
        { type: "action_item", content: "Add metrics dashboard" },
      ],
    });

    await promoteToRiver(sb, "conv-test-001");

    expect(fetchCalls).toHaveLength(1);
    const { body } = fetchCalls[0];
    expect(body.operation).toBe("create");
    expect(body.path).toMatch(/^conversations\/conv-test-001-\d{4}-\d{2}-\d{2}\.md$/);
    expect(body.content).toContain("type: conversation");
    expect(body.content).toContain("conversation_id: conv-test-001");
    expect(body.content).toContain("channel: telegram");
    expect(body.content).toContain("## Summary");
    expect(body.content).toContain("ELLIE-612");
    expect(body.content).toContain("## Extracted Facts");
    expect(body.content).toContain("River promoter handles conversation close");
    expect(body.content).toContain("## Action Items");
    expect(body.content).toContain("Add metrics dashboard");
  });

  it("skips when conversation not found", async () => {
    const sb = mockSupabase({ conversation: null });

    await promoteToRiver(sb, "nonexistent");

    expect(fetchCalls).toHaveLength(0);
  });

  it("skips when conversation has no summary", async () => {
    const sb = mockSupabase({
      conversation: makeConversation({ summary: null }),
    });

    await promoteToRiver(sb, "conv-test-001");

    expect(fetchCalls).toHaveLength(0);
  });

  it("writes document without facts/actions when none exist", async () => {
    const sb = mockSupabase({
      conversation: makeConversation(),
      memories: [],
    });

    await promoteToRiver(sb, "conv-test-001");

    expect(fetchCalls).toHaveLength(1);
    const { body } = fetchCalls[0];
    expect(body.content).toContain("## Summary");
    expect(body.content).not.toContain("## Extracted Facts");
    expect(body.content).not.toContain("## Action Items");
  });

  it("includes agent in frontmatter when present", async () => {
    const sb = mockSupabase({
      conversation: makeConversation({ agent: "research" }),
    });

    await promoteToRiver(sb, "conv-test-001");

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body.content).toContain("agent: research");
  });

  it("handles missing agent gracefully", async () => {
    const sb = mockSupabase({
      conversation: makeConversation({ agent: null }),
    });

    await promoteToRiver(sb, "conv-test-001");

    expect(fetchCalls).toHaveLength(1);
    // Should still write — agent is optional
    expect(fetchCalls[0].body.content).not.toContain("agent:");
  });

  it("does not throw when fetch fails (graceful failure)", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Internal Server Error", { status: 500 });
    }) as typeof fetch;

    const sb = mockSupabase({
      conversation: makeConversation(),
    });

    // Should not throw — graceful failure is a key acceptance criterion
    await promoteToRiver(sb, "conv-test-001");
  });

  it("does not throw when Supabase query fails", async () => {
    const sb = {
      from: () => ({
        select: () => ({
          eq: () => ({
            single: () => Promise.reject(new Error("DB connection lost")),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    // Should not throw — wrapped in try/catch
    await promoteToRiver(sb, "conv-test-001");
    expect(fetchCalls).toHaveLength(0);
  });

  it("separates facts from action items in memories query", async () => {
    const sb = mockSupabase({
      conversation: makeConversation(),
      memories: [
        { type: "fact", content: "Fact A" },
        { type: "fact", content: "Fact B" },
        { type: "action_item", content: "Action 1" },
      ],
    });

    await promoteToRiver(sb, "conv-test-001");

    expect(fetchCalls).toHaveLength(1);
    const content = fetchCalls[0].body.content as string;
    // Facts should be in Extracted Facts section
    expect(content).toContain("- Fact A");
    expect(content).toContain("- Fact B");
    // Action items should be in Action Items section with checkboxes
    expect(content).toContain("- [ ] Action 1");
  });

  it("includes session details in document body", async () => {
    const sb = mockSupabase({
      conversation: makeConversation({
        message_count: 25,
        started_at: "2026-03-06T10:00:00Z",
        ended_at: "2026-03-06T11:30:00Z",
      }),
    });

    await promoteToRiver(sb, "conv-test-001");

    const content = fetchCalls[0].body.content as string;
    expect(content).toContain("**Messages**: 25");
    expect(content).toContain("**Started**: 2026-03-06T10:00:00Z");
    expect(content).toContain("**Ended**: 2026-03-06T11:30:00Z");
  });
});
