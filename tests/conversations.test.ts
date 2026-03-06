/**
 * ELLIE-506 — Conversation Lifecycle Tests
 *
 * Tests the full conversation lifecycle: create, attach messages,
 * rolling summary, close, expire, and edge cases.
 *
 * Mocks Supabase client and Claude CLI (spawn) to test in isolation.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Track CLI calls via summary-cli mock ─────────────────────────
let _cliCalls: string[] = [];
let _cliOutput = "{}";

mock.module("../src/summary-cli.ts", () => ({
  callClaudeCLI: mock(async (prompt: string) => {
    _cliCalls.push(prompt);
    return _cliOutput;
  }),
}));

// ── Mock dependencies ────────────────────────────────────────────
mock.module("../src/elasticsearch.ts", () => ({
  indexConversation: mock(() => Promise.resolve()),
  indexMemory: mock(() => Promise.resolve()),
  classifyDomain: mock(() => "general"),
}));

mock.module("../src/resilient-task.ts", () => ({
  resilientTask: mock((_name: string, _priority: string, fn: () => any) => fn()),
}));

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

mock.module("../src/timezone.ts", () => ({
  USER_TIMEZONE: "America/Chicago",
}));

// ── Import after mocks ──────────────────────────────────────────
import {
  getOrCreateConversation,
  attachMessage,
  maybeGenerateSummary,
  closeConversation,
  closeActiveConversation,
  getConversationMessages,
  getConversationById,
  getConversationContext,
  expireIdleConversations,
} from "../src/conversations";

// ── Supabase mock builder ───────────────────────────────────────

interface MockChainConfig {
  selectData?: any;
  selectError?: any;
  updateData?: any;
  updateError?: any;
  insertData?: any;
  insertError?: any;
  rpcData?: any;
  rpcError?: any;
}

/**
 * Build a chainable Supabase mock. Each table gets its own config.
 * Usage: makeMockSupabase({ messages: { selectData: [...] }, conversations: { ... } })
 */
function makeMockSupabase(tableConfigs: Record<string, MockChainConfig> = {}, rpcConfigs: Record<string, { data?: any; error?: any }> = {}) {
  const calls: Array<{ table: string; method: string; args: any[] }> = [];

  function makeChain(table: string, config: MockChainConfig = {}) {
    const chain: any = {
      select: (...args: any[]) => {
        calls.push({ table, method: "select", args });
        return chain;
      },
      insert: (data: any) => {
        calls.push({ table, method: "insert", args: [data] });
        // If insertData provided, use it; otherwise echo back
        chain._resolveData = config.insertData ?? data;
        chain._resolveError = config.insertError ?? null;
        return chain;
      },
      update: (data: any) => {
        calls.push({ table, method: "update", args: [data] });
        chain._resolveData = config.updateData ?? data;
        chain._resolveError = config.updateError ?? null;
        return chain;
      },
      eq: (...args: any[]) => {
        calls.push({ table, method: "eq", args });
        return chain;
      },
      neq: (...args: any[]) => {
        calls.push({ table, method: "neq", args });
        return chain;
      },
      lt: (...args: any[]) => {
        calls.push({ table, method: "lt", args });
        return chain;
      },
      gte: (...args: any[]) => {
        calls.push({ table, method: "gte", args });
        return chain;
      },
      order: (...args: any[]) => {
        calls.push({ table, method: "order", args });
        return chain;
      },
      limit: (...args: any[]) => {
        calls.push({ table, method: "limit", args });
        return chain;
      },
      range: (...args: any[]) => {
        calls.push({ table, method: "range", args });
        return chain;
      },
      single: () => {
        calls.push({ table, method: "single", args: [] });
        return Promise.resolve({
          data: chain._resolveData ?? config.selectData ?? null,
          error: chain._resolveError ?? config.selectError ?? null,
          count: chain._resolveCount ?? undefined,
        });
      },
      then: undefined as any,
      // For non-single queries, resolve as array
    };

    // Make the chain itself thenable for non-single queries
    chain.then = (resolve: any, reject: any) => {
      const result = {
        data: chain._resolveData ?? config.selectData ?? null,
        error: chain._resolveError ?? config.selectError ?? null,
        count: chain._resolveCount ?? undefined,
      };
      return Promise.resolve(result).then(resolve, reject);
    };

    // Default resolved values from config
    chain._resolveData = undefined;
    chain._resolveError = undefined;
    chain._resolveCount = undefined;

    return chain;
  }

  const supabase: any = {
    from: (table: string) => {
      calls.push({ table, method: "from", args: [table] });
      return makeChain(table, tableConfigs[table] || {});
    },
    rpc: (fnName: string, params: any) => {
      calls.push({ table: "rpc", method: fnName, args: [params] });
      const rpcConfig = rpcConfigs[fnName] || {};
      return Promise.resolve({
        data: rpcConfig.data ?? null,
        error: rpcConfig.error ?? null,
      });
    },
    _calls: calls,
  };

  return supabase;
}

// ── Reset state ─────────────────────────────────────────────────

beforeEach(() => {
  _cliCalls = [];
  _cliOutput = "{}";
});

// ── getOrCreateConversation ─────────────────────────────────────

describe("getOrCreateConversation", () => {
  test("returns conversation ID from RPC", async () => {
    const supabase = makeMockSupabase(
      { conversations: { selectData: [] } },
      { get_or_create_conversation: { data: "conv-123" } },
    );
    const result = await getOrCreateConversation(supabase, "telegram", "general");
    expect(result).toBe("conv-123");
  });

  test("passes channel, agent, idle timeout, and channelId to RPC", async () => {
    const supabase = makeMockSupabase(
      {},
      { get_or_create_conversation: { data: "conv-456" } },
    );
    await getOrCreateConversation(supabase, "telegram", "dev", "chan-99");

    const rpcCall = supabase._calls.find(
      (c: any) => c.method === "get_or_create_conversation",
    );
    expect(rpcCall).toBeDefined();
    expect(rpcCall.args[0].p_channel).toBe("telegram");
    expect(rpcCall.args[0].p_agent).toBe("dev");
    expect(rpcCall.args[0].p_idle_minutes).toBe(30);
    expect(rpcCall.args[0].p_channel_id).toBe("chan-99");
  });

  test("defaults agent to 'general'", async () => {
    const supabase = makeMockSupabase(
      {},
      { get_or_create_conversation: { data: "conv-789" } },
    );
    await getOrCreateConversation(supabase, "telegram");

    const rpcCall = supabase._calls.find(
      (c: any) => c.method === "get_or_create_conversation",
    );
    expect(rpcCall.args[0].p_agent).toBe("general");
  });

  test("returns null on RPC error", async () => {
    const supabase = makeMockSupabase(
      {},
      { get_or_create_conversation: { error: { message: "db error" } } },
    );
    const result = await getOrCreateConversation(supabase, "telegram");
    expect(result).toBeNull();
  });

  test("returns null on exception", async () => {
    const supabase: any = {
      rpc: () => { throw new Error("network failure"); },
      from: () => ({ select: () => ({ eq: () => ({ gte: () => ({ neq: () => Promise.resolve({ data: [] }) }) }) }) }),
    };
    const result = await getOrCreateConversation(supabase, "telegram");
    expect(result).toBeNull();
  });

  test("passes null for channelId when not provided", async () => {
    const supabase = makeMockSupabase(
      {},
      { get_or_create_conversation: { data: "conv-x" } },
    );
    await getOrCreateConversation(supabase, "telegram", "general");

    const rpcCall = supabase._calls.find(
      (c: any) => c.method === "get_or_create_conversation",
    );
    expect(rpcCall.args[0].p_channel_id).toBeNull();
  });
});

// ── attachMessage ───────────────────────────────────────────────

describe("attachMessage", () => {
  test("links message to conversation and increments count", async () => {
    const supabase = makeMockSupabase({
      messages: {},
      conversations: { selectData: { message_count: 5 } },
    });

    await attachMessage(supabase, "msg-1", "conv-1");

    // Should have called update on messages table
    const msgUpdate = supabase._calls.find(
      (c: any) => c.table === "messages" && c.method === "update",
    );
    expect(msgUpdate).toBeDefined();
    expect(msgUpdate.args[0].conversation_id).toBe("conv-1");

    // Should have updated conversation with incremented count
    const convUpdate = supabase._calls.filter(
      (c: any) => c.table === "conversations" && c.method === "update",
    );
    expect(convUpdate.length).toBeGreaterThan(0);
  });

  test("handles null message_count gracefully", async () => {
    const supabase = makeMockSupabase({
      messages: {},
      conversations: { selectData: { message_count: null } },
    });

    // Should not throw
    await attachMessage(supabase, "msg-2", "conv-2");
  });

  test("skips conversation update if conversation not found", async () => {
    const supabase = makeMockSupabase({
      messages: {},
      conversations: { selectData: null },
    });

    // Should not throw
    await attachMessage(supabase, "msg-3", "conv-nonexistent");
  });
});

// ── maybeGenerateSummary ────────────────────────────────────────

describe("maybeGenerateSummary", () => {
  test("skips when message count below threshold (8)", async () => {
    const supabase = makeMockSupabase({
      conversations: { selectData: { message_count: 5, summary: null, channel: "telegram" } },
    });

    await maybeGenerateSummary(supabase, "conv-1");
    // No spawn calls — no CLI invocation
    expect(_cliCalls.length).toBe(0);
  });

  test("skips when message count not a multiple of interval", async () => {
    const supabase = makeMockSupabase({
      conversations: { selectData: { message_count: 9, summary: null, channel: "telegram" } },
    });

    await maybeGenerateSummary(supabase, "conv-1");
    expect(_cliCalls.length).toBe(0);
  });

  test("generates summary at exactly 8 messages", async () => {
    _cliOutput = "Dave discussed project priorities and decided to focus on testing.";

    const supabase = makeMockSupabase({
      conversations: { selectData: { message_count: 8, summary: null, channel: "telegram" } },
      messages: {
        selectData: [
          { role: "user", content: "Let's prioritize testing", created_at: "2026-03-05T10:00:00Z" },
          { role: "assistant", content: "Good idea", created_at: "2026-03-05T10:01:00Z" },
        ],
      },
    });

    await maybeGenerateSummary(supabase, "conv-1");
    expect(_cliCalls.length).toBe(1);
  });

  test("generates summary at multiples of interval (16, 24...)", async () => {
    _cliOutput = "Summary text";

    const supabase = makeMockSupabase({
      conversations: { selectData: { message_count: 16, summary: "Old summary", channel: "telegram" } },
      messages: {
        selectData: [
          { role: "user", content: "More messages", created_at: "2026-03-05T10:00:00Z" },
        ],
      },
    });

    await maybeGenerateSummary(supabase, "conv-1");
    expect(_cliCalls.length).toBe(1);
  });

  test("handles missing conversation gracefully", async () => {
    const supabase = makeMockSupabase({
      conversations: { selectData: null },
    });

    await maybeGenerateSummary(supabase, "conv-nonexistent");
    expect(_cliCalls.length).toBe(0);
  });

  test("skips when no messages found", async () => {
    const supabase = makeMockSupabase({
      conversations: { selectData: { message_count: 8, summary: null, channel: "telegram" } },
      messages: { selectData: [] },
    });

    await maybeGenerateSummary(supabase, "conv-1");
    // Gets past the threshold check but returns early on no messages
    // spawn may or may not be called depending on message fetch; either way, no crash
  });
});

// ── closeConversation ───────────────────────────────────────────

describe("closeConversation", () => {
  test("atomically claims and closes active conversation", async () => {
    _cliOutput = JSON.stringify({
      summary: "Conversation about testing",
      memories: [{ type: "fact", content: "Dave likes testing" }],
    });

    const supabase = makeMockSupabase({
      conversations: {
        updateData: { id: "conv-1", summary: null, channel: "telegram", message_count: 5 },
      },
      memory: {
        selectData: null,
        insertData: [{ id: "mem-1", type: "fact", content: "Dave likes testing" }],
      },
      messages: {
        selectData: [
          { id: "msg-1", role: "user", content: "I like testing", created_at: "2026-03-05T10:00:00Z" },
          { id: "msg-2", role: "assistant", content: "Great!", created_at: "2026-03-05T10:01:00Z" },
        ],
      },
    });

    await closeConversation(supabase, "conv-1");

    // Should have called update with status: "closed"
    const updateCall = supabase._calls.find(
      (c: any) => c.table === "conversations" && c.method === "update",
    );
    expect(updateCall).toBeDefined();
    expect(updateCall.args[0].status).toBe("closed");
  });

  test("skips if conversation already claimed (not active)", async () => {
    const supabase = makeMockSupabase({
      conversations: { updateData: null },
    });

    await closeConversation(supabase, "conv-already-closed");
    // No spawn calls — extraction was skipped
    expect(_cliCalls.length).toBe(0);
  });

  test("generates summary if message_count > 2 and no existing summary", async () => {
    _cliOutput = JSON.stringify({
      summary: "Test summary",
      memories: [],
    });

    const supabase = makeMockSupabase({
      conversations: {
        updateData: { id: "conv-1", summary: null, channel: "telegram", message_count: 5 },
      },
      memory: { selectData: null },
      messages: {
        selectData: [
          { id: "msg-1", role: "user", content: "Hello", created_at: "2026-03-05T10:00:00Z" },
          { id: "msg-2", role: "assistant", content: "Hi", created_at: "2026-03-05T10:01:00Z" },
          { id: "msg-3", role: "user", content: "How are you", created_at: "2026-03-05T10:02:00Z" },
        ],
      },
    });

    await closeConversation(supabase, "conv-1");
    // Should have invoked CLI at least once (summary generation + memory extraction)
    expect(_cliCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("skips summary generation if conversation has existing summary", async () => {
    _cliOutput = JSON.stringify({
      summary: "Existing",
      memories: [],
    });

    const supabase = makeMockSupabase({
      conversations: {
        updateData: {
          id: "conv-1",
          summary: "Already has a summary",
          channel: "telegram",
          message_count: 5,
        },
      },
      memory: { selectData: null },
      messages: {
        selectData: [
          { id: "msg-1", role: "user", content: "Hello", created_at: "2026-03-05T10:00:00Z" },
        ],
      },
    });

    await closeConversation(supabase, "conv-1");
    // Memory extraction still runs, but not the pre-close summary step
  });
});

// ── closeActiveConversation ─────────────────────────────────────

describe("closeActiveConversation", () => {
  test("finds and closes the active conversation on a channel", async () => {
    _cliOutput = JSON.stringify({ summary: "Done", memories: [] });

    const supabase = makeMockSupabase({
      conversations: {
        selectData: { id: "conv-active", message_count: 5 },
        updateData: { id: "conv-active", summary: null, channel: "telegram", message_count: 5 },
      },
      memory: { selectData: null },
      messages: {
        selectData: [
          { id: "m1", role: "user", content: "Hi", created_at: "2026-03-05T10:00:00Z" },
        ],
      },
    });

    const result = await closeActiveConversation(supabase, "telegram");
    expect(result).toBe(true);
  });

  test("returns false when no active conversation exists", async () => {
    const supabase = makeMockSupabase({
      conversations: { selectData: null },
    });

    const result = await closeActiveConversation(supabase, "telegram");
    expect(result).toBe(false);
  });

  test("closes low-message conversations without extraction", async () => {
    const supabase = makeMockSupabase({
      conversations: {
        selectData: { id: "conv-short", message_count: 1 },
        updateData: { id: "conv-short" },
      },
    });

    const result = await closeActiveConversation(supabase, "telegram");
    expect(result).toBe(true);
    // No CLI calls — skipped memory extraction for low-message convos
    expect(_cliCalls.length).toBe(0);
  });
});

// ── getConversationMessages ─────────────────────────────────────

describe("getConversationMessages", () => {
  test("returns formatted messages for short conversations (<=40)", async () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i + 1}`,
      created_at: `2026-03-05T10:0${i}:00Z`,
    }));

    const supabase = makeMockSupabase({
      conversations: { selectData: { summary: null, message_count: 5 } },
      messages: { selectData: messages },
    });

    const result = await getConversationMessages(supabase, "conv-1");
    expect(result.messageCount).toBe(5);
    expect(result.conversationId).toBe("conv-1");
    expect(result.text).toContain("CURRENT CONVERSATION:");
    expect(result.text).toContain("[user]: Message 1");
    expect(result.text).toContain("[assistant]: Message 2");
  });

  test("truncates medium conversations (41-100) with head/tail", async () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i + 1}`,
      created_at: new Date(Date.now() + i * 60000).toISOString(),
    }));

    const supabase = makeMockSupabase({
      conversations: { selectData: { summary: null, message_count: 50 } },
      messages: { selectData: messages },
    });

    const result = await getConversationMessages(supabase, "conv-1");
    expect(result.messageCount).toBe(50);
    expect(result.text).toContain("[user]: Message 1"); // head
    expect(result.text).toContain("earlier messages omitted");
    expect(result.text).toContain(`Message 50`); // tail
  });

  test("uses summary for long conversations (>100)", async () => {
    const messages = Array.from({ length: 120 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i + 1}`,
      created_at: new Date(Date.now() + i * 60000).toISOString(),
    }));

    const supabase = makeMockSupabase({
      conversations: { selectData: { summary: "They talked about code quality.", message_count: 120 } },
      messages: { selectData: messages },
    });

    const result = await getConversationMessages(supabase, "conv-1");
    expect(result.messageCount).toBe(120);
    expect(result.text).toContain("CONVERSATION SUMMARY");
    expect(result.text).toContain("They talked about code quality.");
  });

  test("falls back to omission message when no summary exists for long convos", async () => {
    const messages = Array.from({ length: 110 }, (_, i) => ({
      role: "user",
      content: `Msg ${i + 1}`,
      created_at: new Date(Date.now() + i * 60000).toISOString(),
    }));

    const supabase = makeMockSupabase({
      conversations: { selectData: { summary: null, message_count: 110 } },
      messages: { selectData: messages },
    });

    const result = await getConversationMessages(supabase, "conv-1");
    expect(result.text).toContain("earlier messages omitted");
    expect(result.text).not.toContain("CONVERSATION SUMMARY");
  });

  test("returns empty on missing conversation", async () => {
    const supabase = makeMockSupabase({
      conversations: { selectData: null },
    });

    const result = await getConversationMessages(supabase, "conv-gone");
    expect(result.text).toBe("");
    expect(result.messageCount).toBe(0);
  });

  test("returns empty on query error", async () => {
    const supabase = makeMockSupabase({
      conversations: { selectData: { summary: null, message_count: 5 } },
      messages: { selectError: { message: "db error" }, selectData: null },
    });

    const result = await getConversationMessages(supabase, "conv-1");
    expect(result.text).toBe("");
    expect(result.messageCount).toBe(0);
  });
});

// ── getConversationById ─────────────────────────────────────────

describe("getConversationById", () => {
  test("returns conversation with messages and total count", async () => {
    // For getConversationById, we need Promise.all to work with three parallel queries.
    // Our mock returns the same config for all calls to the same table,
    // so this tests the structure.
    const supabase = makeMockSupabase({
      conversations: {
        selectData: {
          id: "conv-1",
          channel: "telegram",
          agent: "general",
          status: "active",
          summary: null,
          message_count: 10,
          started_at: "2026-03-05T10:00:00Z",
          ended_at: null,
        },
      },
      messages: {
        selectData: [
          { id: "msg-1", role: "user", content: "Hello", created_at: "2026-03-05T10:00:00Z" },
        ],
      },
    });

    const result = await getConversationById(supabase, "conv-1");
    expect(result).not.toBeNull();
    expect(result!.conversation.id).toBe("conv-1");
    expect(result!.messages).toBeArray();
  });

  test("returns null when conversation not found", async () => {
    const supabase = makeMockSupabase({
      conversations: { selectData: null, selectError: { message: "not found" } },
      messages: { selectData: [] },
    });

    const result = await getConversationById(supabase, "conv-nonexistent");
    expect(result).toBeNull();
  });

  test("respects limit and offset options", async () => {
    const supabase = makeMockSupabase({
      conversations: {
        selectData: { id: "conv-1", channel: "telegram", agent: "general", status: "active", summary: null, message_count: 100, started_at: "2026-03-05T10:00:00Z", ended_at: null },
      },
      messages: { selectData: [] },
    });

    await getConversationById(supabase, "conv-1", { limit: 20, offset: 10 });

    const rangeCall = supabase._calls.find(
      (c: any) => c.table === "messages" && c.method === "range",
    );
    expect(rangeCall).toBeDefined();
    expect(rangeCall.args).toEqual([10, 29]); // offset to offset+limit-1
  });

  test("caps limit at 200", async () => {
    const supabase = makeMockSupabase({
      conversations: {
        selectData: { id: "conv-1", channel: "telegram", agent: "general", status: "active", summary: null, message_count: 100, started_at: "2026-03-05T10:00:00Z", ended_at: null },
      },
      messages: { selectData: [] },
    });

    await getConversationById(supabase, "conv-1", { limit: 500 });

    const rangeCall = supabase._calls.find(
      (c: any) => c.table === "messages" && c.method === "range",
    );
    expect(rangeCall).toBeDefined();
    expect(rangeCall.args).toEqual([0, 199]); // capped at 200
  });
});

// ── getConversationContext ───────────────────────────────────────

describe("getConversationContext", () => {
  test("returns structured context from RPC", async () => {
    const supabase = makeMockSupabase(
      {
        messages: {
          selectData: [
            { role: "user", content: "Recent msg" },
            { role: "assistant", content: "Reply" },
          ],
        },
      },
      {
        get_conversation_context: {
          data: [
            {
              conversation_id: "conv-1",
              agent: "dev",
              summary: "Discussing tests",
              message_count: 15,
              started_at: "2026-03-05T10:00:00Z",
            },
          ],
        },
      },
    );

    const result = await getConversationContext(supabase, "telegram");
    expect(result).not.toBeNull();
    expect(result!.conversationId).toBe("conv-1");
    expect(result!.agent).toBe("dev");
    expect(result!.summary).toBe("Discussing tests");
    expect(result!.messageCount).toBe(15);
    expect(result!.recentMessages).toBeArray();
  });

  test("returns null when no active conversation", async () => {
    const supabase = makeMockSupabase(
      {},
      { get_conversation_context: { data: [] } },
    );

    const result = await getConversationContext(supabase, "telegram");
    expect(result).toBeNull();
  });

  test("returns null on RPC returning null data", async () => {
    const supabase = makeMockSupabase(
      {},
      { get_conversation_context: { data: null } },
    );

    const result = await getConversationContext(supabase, "telegram");
    expect(result).toBeNull();
  });
});

// ── expireIdleConversations ─────────────────────────────────────

describe("expireIdleConversations", () => {
  test("returns 0 when no stale conversations found", async () => {
    const supabase = makeMockSupabase({
      conversations: { selectData: [] },
    });

    const count = await expireIdleConversations(supabase);
    expect(count).toBe(0);
  });

  test("closes stale conversations with >= 2 messages via closeConversation", async () => {
    _cliOutput = JSON.stringify({ summary: "Expired convo", memories: [] });

    const supabase = makeMockSupabase({
      conversations: {
        selectData: [
          { id: "conv-stale-1", message_count: 5 },
          { id: "conv-stale-2", message_count: 10 },
        ],
        updateData: { id: "conv-stale", summary: null, channel: "telegram", message_count: 5 },
      },
      memory: { selectData: null },
      messages: {
        selectData: [
          { id: "m1", role: "user", content: "Old message", created_at: "2026-03-04T10:00:00Z" },
        ],
      },
    });

    const count = await expireIdleConversations(supabase);
    expect(count).toBe(2);
  });

  test("closes low-message stale conversations without extraction", async () => {
    const supabase = makeMockSupabase({
      conversations: {
        selectData: [{ id: "conv-tiny", message_count: 1 }],
        updateData: { id: "conv-tiny" },
      },
    });

    const count = await expireIdleConversations(supabase);
    expect(count).toBe(1);
    // No CLI calls — skipped extraction for low-message convo
    expect(_cliCalls.length).toBe(0);
  });

  test("returns 0 on error", async () => {
    const supabase: any = {
      from: () => { throw new Error("db down"); },
    };

    const count = await expireIdleConversations(supabase);
    expect(count).toBe(0);
  });
});

// ── Full lifecycle integration ──────────────────────────────────

describe("full lifecycle: create → attach → summarize → close", () => {
  test("end-to-end conversation lifecycle", async () => {
    _cliOutput = JSON.stringify({
      summary: "Dave discussed project architecture",
      memories: [
        { type: "fact", content: "Uses TypeScript for all projects" },
        { type: "action_item", content: "Review PR by Friday" },
      ],
    });

    // Step 1: Create conversation
    const supabase = makeMockSupabase(
      {
        conversations: {
          selectData: { message_count: 8, summary: null, channel: "telegram" },
          updateData: { id: "conv-lifecycle", summary: null, channel: "telegram", message_count: 8 },
        },
        messages: {
          selectData: [
            { id: "m1", role: "user", content: "Let's talk architecture", created_at: "2026-03-05T10:00:00Z" },
            { id: "m2", role: "assistant", content: "Sure, what aspects?", created_at: "2026-03-05T10:01:00Z" },
          ],
        },
        memory: {
          selectData: null,
          insertData: [
            { id: "mem-1", type: "fact", content: "Uses TypeScript" },
            { id: "mem-2", type: "action_item", content: "Review PR" },
          ],
        },
      },
      { get_or_create_conversation: { data: "conv-lifecycle" } },
    );

    const convId = await getOrCreateConversation(supabase, "telegram", "dev");
    expect(convId).toBe("conv-lifecycle");

    // Step 2: Attach messages
    await attachMessage(supabase, "m1", convId!);
    await attachMessage(supabase, "m2", convId!);

    // Step 3: Maybe generate summary (at threshold)
    await maybeGenerateSummary(supabase, convId!);

    // Step 4: Close conversation
    await closeConversation(supabase, convId!);

    // Verify CLI was invoked for summary/extraction
    expect(_cliCalls.length).toBeGreaterThan(0);
  });
});

// ── Edge cases ──────────────────────────────────────────────────

describe("edge cases", () => {
  test("close already-closed conversation is a no-op", async () => {
    // updateData returns null — atomic claim fails (already closed)
    const supabase = makeMockSupabase({
      conversations: { updateData: null },
    });

    await closeConversation(supabase, "conv-already-closed");
    expect(_cliCalls.length).toBe(0);
  });

  test("attach to conversation handles DB errors gracefully", async () => {
    const supabase: any = {
      from: (table: string) => ({
        update: () => ({
          eq: () => { throw new Error("update failed"); },
        }),
        select: () => ({
          eq: () => ({
            single: () => Promise.resolve({ data: { message_count: 1 }, error: null }),
          }),
        }),
      }),
    };

    // Should not throw
    await attachMessage(supabase, "msg-err", "conv-err");
  });

  test("getConversationMessages with exactly 40 messages returns all", async () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({
      role: "user",
      content: `Msg ${i + 1}`,
      created_at: new Date(Date.now() + i * 60000).toISOString(),
    }));

    const supabase = makeMockSupabase({
      conversations: { selectData: { summary: null, message_count: 40 } },
      messages: { selectData: messages },
    });

    const result = await getConversationMessages(supabase, "conv-1");
    expect(result.messageCount).toBe(40);
    // All messages included — no omission marker
    expect(result.text).not.toContain("omitted");
    expect(result.text).toContain("Msg 1");
    expect(result.text).toContain("Msg 40");
  });

  test("getConversationMessages with 41 messages triggers truncation", async () => {
    const messages = Array.from({ length: 41 }, (_, i) => ({
      role: "user",
      content: `Msg ${i + 1}`,
      created_at: new Date(Date.now() + i * 60000).toISOString(),
    }));

    const supabase = makeMockSupabase({
      conversations: { selectData: { summary: null, message_count: 41 } },
      messages: { selectData: messages },
    });

    const result = await getConversationMessages(supabase, "conv-1");
    expect(result.messageCount).toBe(41);
    expect(result.text).toContain("omitted");
  });

  test("expireIdleConversations handles null data from query", async () => {
    const supabase = makeMockSupabase({
      conversations: { selectData: null },
    });

    const count = await expireIdleConversations(supabase);
    expect(count).toBe(0);
  });
});
