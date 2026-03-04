/**
 * ELLIE-498 — Pipeline helper unit tests
 *
 * Covers: _resolveContextMode, _buildShouldFetch, _gatherContextSources
 * (extracted from ellie-chat-handler.ts to ellie-chat-pipeline.ts)
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mock heavy context-source dependencies before importing the module ────────
// _gatherContextSources calls 9 async source functions; mock them all out.

mock.module("../src/conversations.ts", () => ({
  getConversationMessages: mock(() =>
    Promise.resolve({ text: "prev messages", messageCount: 2, conversationId: "conv-1" })
  ),
}));

mock.module("../src/relay-config.ts", () => ({
  getContextDocket: mock(() => Promise.resolve("docket text")),
  clearContextCache: mock(() => {}),
  BOT_TOKEN: "fake",
  ALLOWED_USER_ID: "fake",
  GCHAT_SPACE_NOTIFY: "fake",
  UPLOADS_DIR: "/tmp",
  getArchetypeContext: mock(() => Promise.resolve("")),
}));

mock.module("../src/memory.ts", () => ({
  getRelevantContext: mock(() => Promise.resolve("relevant ctx")),
  processMemoryIntents: mock((_, text: string) => Promise.resolve(text)),
}));

mock.module("../src/elasticsearch.ts", () => ({
  searchElastic: mock(() => Promise.resolve("elastic results")),
}));

mock.module("../src/context-sources.ts", () => ({
  getAgentStructuredContext: mock(() => Promise.resolve("structured ctx")),
  getAgentMemoryContext: mock(() =>
    Promise.resolve({ memoryContext: "memory", sessionIds: null })
  ),
  getMaxMemoriesForModel: mock(() => 10),
  getLiveForestContext: mock(() =>
    Promise.resolve({ awareness: "forest awareness", incidents: null })
  ),
  refreshSource: mock(() => Promise.resolve("")),
}));

mock.module("../src/elasticsearch/context.ts", () => ({
  getForestContext: mock(() => Promise.resolve("forest ctx")),
}));

mock.module("../src/api/agent-queue.ts", () => ({
  getQueueContext: mock(() => Promise.resolve("queue ctx")),
  acknowledgeQueueItems: mock(() => Promise.resolve()),
}));

// ── Now import (after mocks are registered) ───────────────────────────────────

import {
  _resolveContextMode,
  _buildShouldFetch,
  _gatherContextSources,
} from "../src/ellie-chat-pipeline.ts";

import { setCreatureProfile } from "../src/creature-profile.ts";

// ── _resolveContextMode ───────────────────────────────────────────────────────

describe("_resolveContextMode", () => {
  test("channel profile provided → returns profile contextMode, modeChanged=false", () => {
    const channelProfile = {
      contextMode: "deep-work" as const,
      tokenBudget: 190_000,
      workItemId: null,
    } as any;

    const result = _resolveContextMode("any-key", "any text", channelProfile);

    expect(result.contextMode).toBe("deep-work");
    expect(result.modeChanged).toBe(false);
  });

  test("null channelProfile → delegates to processMessageMode, returns default conversation mode", () => {
    // Fresh convo key — no previous mode set, no signal in text
    const result = _resolveContextMode("resolve-test-fresh-" + Date.now(), "just chatting", null);

    expect(result.contextMode).toBe("conversation");
    expect(result.modeChanged).toBe(false);
  });

  test("undefined channelProfile → same as null, defaults to conversation", () => {
    const result = _resolveContextMode("resolve-test-undef-" + Date.now(), "hello", undefined);

    expect(result.contextMode).toBe("conversation");
    expect(result.modeChanged).toBe(false);
  });

  test("deep work trigger → mode transitions, modeChanged=true", () => {
    const convoKey = "resolve-test-dw-" + Date.now();
    const result = _resolveContextMode(convoKey, "deep work on ELLIE-123", null);

    expect(result.contextMode).toBe("deep-work");
    expect(result.modeChanged).toBe(true);
  });

  test("manual override 'skill-only mode' → mode=skill-only", () => {
    const result = _resolveContextMode("resolve-test-so-" + Date.now(), "skill-only mode please", null);

    expect(result.contextMode).toBe("skill-only");
    expect(result.modeChanged).toBe(true);
  });

  test("channel profile always wins even when message would trigger different mode", () => {
    const channelProfile = { contextMode: "strategy" as const, tokenBudget: 150_000, workItemId: null } as any;

    // Message would normally trigger deep-work, but profile overrides
    const result = _resolveContextMode("any-key-2", "deep work on ELLIE-500", channelProfile);

    expect(result.contextMode).toBe("strategy");
    expect(result.modeChanged).toBe(false);
  });
});

// ── _buildShouldFetch ─────────────────────────────────────────────────────────
//
// Priority table (from DEFAULT_MODE_PRIORITIES in context-mode.ts):
//   conversation: search=9, context-docket=7, soul=2, structured-context=4, work-item=5
//   skill-only:   soul=9, archetype=2, queue=3, context-docket=9
//   Threshold: priority < 7 → fetch (true); priority >= 7 → suppress (false)

describe("_buildShouldFetch — mode priorities (no creature profile)", () => {
  test("conversation/search (priority 9) → false (suppressed)", () => {
    const sf = _buildShouldFetch("conversation", "agent-no-creature-1");
    expect(sf("search")).toBe(false);
  });

  test("conversation/context-docket (priority 7) → false (boundary, >= 7)", () => {
    const sf = _buildShouldFetch("conversation", "agent-no-creature-2");
    expect(sf("context-docket")).toBe(false);
  });

  test("conversation/soul (priority 2) → true", () => {
    const sf = _buildShouldFetch("conversation", "agent-no-creature-3");
    expect(sf("soul")).toBe(true);
  });

  test("conversation/structured-context (priority 4) → true", () => {
    const sf = _buildShouldFetch("conversation", "agent-no-creature-4");
    expect(sf("structured-context")).toBe(true);
  });

  test("skill-only/soul (priority 9) → false", () => {
    const sf = _buildShouldFetch("skill-only", "agent-no-creature-5");
    expect(sf("soul")).toBe(false);
  });

  test("skill-only/archetype (priority 2) → true", () => {
    const sf = _buildShouldFetch("skill-only", "agent-no-creature-6");
    expect(sf("archetype")).toBe(true);
  });

  test("skill-only/queue (priority 3) → true", () => {
    const sf = _buildShouldFetch("skill-only", "agent-no-creature-7");
    expect(sf("queue")).toBe(true);
  });

  test("unknown label (not in priorities map) → defaults to 0 → true (not suppressed)", () => {
    const sf = _buildShouldFetch("conversation", "agent-no-creature-8");
    expect(sf("totally-unknown-label")).toBe(true);
  });
});

describe("_buildShouldFetch — creature profile overrides mode priorities", () => {
  const AGENT = "test-creature-override";

  beforeEach(() => {
    // Register a creature profile that flips conversation defaults
    setCreatureProfile(AGENT, {
      section_priorities: {
        "structured-context": 8,  // override: conversation default is 4 (true) → now 8 (false)
        "search": 2,              // override: conversation default is 9 (false) → now 2 (true)
      },
    });
  });

  test("creature priority 8 overrides mode priority 4 → false", () => {
    const sf = _buildShouldFetch("conversation", AGENT);
    expect(sf("structured-context")).toBe(false);
  });

  test("creature priority 2 overrides mode priority 9 → true", () => {
    const sf = _buildShouldFetch("conversation", AGENT);
    expect(sf("search")).toBe(true);
  });

  test("label not in creature profile falls back to mode priority", () => {
    const sf = _buildShouldFetch("conversation", AGENT);
    // soul: not in creature profile, conversation default is 2 → true
    expect(sf("soul")).toBe(true);
    // context-docket: not in creature profile, conversation default is 7 → false
    expect(sf("context-docket")).toBe(false);
  });

  test("null creature profile (agent not registered) → uses mode priority only", () => {
    const sf = _buildShouldFetch("conversation", "totally-unregistered-agent-xyz");
    // search in conversation mode = 9 → false
    expect(sf("search")).toBe(false);
    // soul in conversation mode = 2 → true
    expect(sf("soul")).toBe(true);
  });
});

// ── _gatherContextSources ─────────────────────────────────────────────────────

describe("_gatherContextSources", () => {
  test("returns all 9 keys in the result object", async () => {
    const sf = () => true; // fetch everything
    const result = await _gatherContextSources(
      null, undefined, "test query", "general", null, undefined, sf,
    );

    expect(result).toHaveProperty("convoContext");
    expect(result).toHaveProperty("contextDocket");
    expect(result).toHaveProperty("relevantContext");
    expect(result).toHaveProperty("elasticContext");
    expect(result).toHaveProperty("structuredContext");
    expect(result).toHaveProperty("forestContext");
    expect(result).toHaveProperty("agentMemory");
    expect(result).toHaveProperty("queueContext");
    expect(result).toHaveProperty("liveForest");
  });

  test("convoContext is empty default when supabase=null and convoId=undefined", async () => {
    const sf = () => true;
    const result = await _gatherContextSources(
      null, undefined, "test", "general", null, undefined, sf,
    );

    expect(result.convoContext).toEqual({ text: "", messageCount: 0, conversationId: "" });
  });

  test("convoContext fetched when supabase and convoId are both provided", async () => {
    const mockSupabase = {} as any; // truthy — triggers the getConversationMessages path
    const sf = () => true;
    const result = await _gatherContextSources(
      mockSupabase, "conv-abc", "test", "general", null, undefined, sf,
    );

    // Mock returns { text: "prev messages", ... }
    expect(result.convoContext.text).toBe("prev messages");
  });

  test("contextDocket is empty string when shouldFetch('context-docket')=false", async () => {
    const sf = (label: string) => label !== "context-docket";
    const result = await _gatherContextSources(
      null, undefined, "test", "general", null, undefined, sf,
    );

    expect(result.contextDocket).toBe("");
  });

  test("structuredContext is empty string when shouldFetch('structured-context')=false", async () => {
    const sf = (label: string) => label !== "structured-context";
    const result = await _gatherContextSources(
      null, undefined, "test", "general", null, undefined, sf,
    );

    expect(result.structuredContext).toBe("");
  });

  test("queueContext is empty string when agentDispatch=null (shouldFetch guard short-circuits)", async () => {
    const sf = () => true; // queue is allowed by shouldFetch, but no dispatch
    const result = await _gatherContextSources(
      null, undefined, "test", "general", null, undefined, sf,
    );

    // agentDispatch is null → agentDispatch?.is_new is undefined (falsy) → Promise.resolve("")
    expect(result.queueContext).toBe("");
  });

  test("queueContext is empty string when agentDispatch.is_new=false", async () => {
    const sf = () => true;
    const result = await _gatherContextSources(
      null, undefined, "test", "general",
      { is_new: false, agent: { model: null } },
      undefined, sf,
    );

    expect(result.queueContext).toBe("");
  });

  test("queueContext is fetched when shouldFetch('queue')=true and agentDispatch.is_new=true", async () => {
    const sf = () => true;
    const result = await _gatherContextSources(
      null, undefined, "test", "general",
      { is_new: true, agent: { model: null } },
      undefined, sf,
    );

    // Mock returns "queue ctx"
    expect(result.queueContext).toBe("queue ctx");
  });
});
