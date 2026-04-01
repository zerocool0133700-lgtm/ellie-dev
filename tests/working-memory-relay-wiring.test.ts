/**
 * ELLIE-541 — working memory relay wiring tests
 *
 * Tests for primeWorkingMemoryCache() — the function that fetches the active
 * working memory record from DB and populates the in-process cache before
 * buildPrompt() is called in the relay message handlers.
 *
 * Coverage:
 *   - Populates cache from DB when active record exists
 *   - Does not populate cache when no active record exists in DB
 *   - No-op when session_id is null
 *   - Different agents get independent cache entries (keyed by agent name)
 *   - Overwrites stale cache with fresh DB data
 *   - All 7 sections are preserved through the DB round-trip
 *   - End-to-end: after priming, buildPrompt injects resumption_prompt
 *   - End-to-end: full working memory appears when fullWorkingMemory=true
 *   - Archived records are not loaded (only active sessions)
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  initWorkingMemory,
  archiveWorkingMemory,
  primeWorkingMemoryCache,
  getCachedWorkingMemory,
  clearWorkingMemoryCache,
  _injectWorkingMemoryForTesting,
} from "../src/working-memory.ts";
import {
  buildPrompt,
  clearRiverDocCache,
} from "../src/prompt-builder.ts";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const RUN_ID = `test-relay-${Date.now()}`;

const sid = (n: number) => `${RUN_ID}-${n}`;

// ── Cleanup ───────────────────────────────────────────────────────────────────

afterAll(async () => {
  const { sql } = await import("../../ellie-forest/src/index.ts");
  await sql`DELETE FROM working_memory WHERE session_id LIKE ${RUN_ID + "%"}`;
  clearWorkingMemoryCache();
  clearRiverDocCache();
});

beforeEach(() => {
  clearWorkingMemoryCache();
  clearRiverDocCache();
});

// ── primeWorkingMemoryCache — DB → cache ──────────────────────────────────────

describe("primeWorkingMemoryCache — DB to cache (ELLIE-541)", () => {
  test("populates cache when active record exists in DB", async () => {
    const session_id = sid(1);
    await initWorkingMemory({ session_id, agent: "dev", sections: { resumption_prompt: "Resume from step 3" } });

    await primeWorkingMemoryCache(session_id, "dev");

    const cached = getCachedWorkingMemory("dev");
    expect(cached).not.toBeNull();
    expect(cached?.sections.resumption_prompt).toBe("Resume from step 3");
    expect(cached?.agent).toBe("dev");
    expect(cached?.session_id).toBe(session_id);
  });

  test("does not populate cache when no active record exists for session+agent", async () => {
    await primeWorkingMemoryCache(`${RUN_ID}-nonexistent`, "general");
    expect(getCachedWorkingMemory("general")).toBeNull();
  });

  test("no-op when session_id is null", async () => {
    await primeWorkingMemoryCache(null, "general");
    expect(getCachedWorkingMemory("general")).toBeNull();
  });

  test("does not load archived records", async () => {
    const session_id = sid(2);
    await initWorkingMemory({ session_id, agent: "dev", sections: { resumption_prompt: "OLD" } });
    await archiveWorkingMemory({ session_id, agent: "dev" });

    await primeWorkingMemoryCache(session_id, "dev");

    // Archived record should not appear in cache
    expect(getCachedWorkingMemory("dev")).toBeNull();
  });

  test("different agents get independent cache entries", async () => {
    const session_id = sid(3);
    await initWorkingMemory({ session_id, agent: "dev", sections: { resumption_prompt: "DEV RESUME" } });
    await initWorkingMemory({ session_id, agent: "research", sections: { resumption_prompt: "RESEARCH RESUME" } });

    await primeWorkingMemoryCache(session_id, "dev");
    await primeWorkingMemoryCache(session_id, "research");

    expect(getCachedWorkingMemory("dev")?.sections.resumption_prompt).toBe("DEV RESUME");
    expect(getCachedWorkingMemory("research")?.sections.resumption_prompt).toBe("RESEARCH RESUME");
  });

  test("overwrites stale injected cache entry with fresh DB data", async () => {
    const session_id = sid(4);
    const agent = "dev";

    // Pre-populate with stale data via test injection
    _injectWorkingMemoryForTesting(agent, { resumption_prompt: "STALE" });
    expect(getCachedWorkingMemory(agent)?.sections.resumption_prompt).toBe("STALE");

    // Create fresh record in DB
    await initWorkingMemory({ session_id, agent, sections: { resumption_prompt: "FRESH" } });

    // Prime should overwrite the stale entry
    await primeWorkingMemoryCache(session_id, agent);
    expect(getCachedWorkingMemory(agent)?.sections.resumption_prompt).toBe("FRESH");
  });

  test("all 7 sections are preserved through the DB round-trip", async () => {
    const session_id = sid(5);
    const sections = {
      session_identity: "dev / ELLIE-541 / ellie-chat",
      task_stack: "1. [ACTIVE] Wire relay\n2. [ ] Write tests",
      conversation_thread: "Working on relay wiring for ELLIE-541.",
      investigation_state: "Checked ellie-chat-handler, telegram-handlers, http-routes.",
      decision_log: "Chose primeWorkingMemoryCache helper over inline code.",
      context_anchors: "src/working-memory.ts:224 — cache starts here.",
      resumption_prompt: "Resume from tests/working-memory-relay-wiring.test.ts.",
    };
    await initWorkingMemory({ session_id, agent: "dev", sections });

    await primeWorkingMemoryCache(session_id, "dev");

    const cached = getCachedWorkingMemory("dev");
    expect(cached?.sections.session_identity).toBe(sections.session_identity);
    expect(cached?.sections.task_stack).toBe(sections.task_stack);
    expect(cached?.sections.conversation_thread).toBe(sections.conversation_thread);
    expect(cached?.sections.investigation_state).toBe(sections.investigation_state);
    expect(cached?.sections.decision_log).toBe(sections.decision_log);
    expect(cached?.sections.context_anchors).toBe(sections.context_anchors);
    expect(cached?.sections.resumption_prompt).toBe(sections.resumption_prompt);
  });

  test("priming for one agent does not affect another agent's cache entry", async () => {
    const session_id = sid(6);
    const agent = "research";
    // Pre-populate research cache
    _injectWorkingMemoryForTesting(agent, { resumption_prompt: "RESEARCH STAYS" });

    // Prime for a different agent (no DB record for general)
    await primeWorkingMemoryCache(session_id, "general");

    // Research cache should be untouched
    expect(getCachedWorkingMemory(agent)?.sections.resumption_prompt).toBe("RESEARCH STAYS");
    expect(getCachedWorkingMemory("general")).toBeNull();
  });
});

// ── End-to-end: prime → buildPrompt ──────────────────────────────────────────

describe("primeWorkingMemoryCache — end-to-end with buildPrompt (ELLIE-541)", () => {
  test("resumption_prompt injected into prompt after priming", async () => {
    const session_id = sid(7);
    const agent = "dev";
    await initWorkingMemory({ session_id, agent, sections: { resumption_prompt: "RELAY_WIRING_MARKER" } });

    await primeWorkingMemoryCache(session_id, agent);

    const result = buildPrompt("Fix it", undefined, undefined, undefined, "telegram", { name: agent });
    expect(result).toContain("RELAY_WIRING_MARKER");
    expect(result).toContain("RESUMPTION CONTEXT:");
  });

  test("resumption_prompt absent when priming finds no DB record", async () => {
    await primeWorkingMemoryCache(`${RUN_ID}-absent`, "general");

    const result = buildPrompt("Hello");
    expect(result).not.toContain("RESUMPTION CONTEXT:");
    expect(result).not.toContain("WORKING MEMORY");
  });

  test("full working memory appears when fullWorkingMemory=true after priming", async () => {
    const session_id = sid(8);
    const agent = "dev";
    await initWorkingMemory({ session_id, agent, sections: {
      session_identity: "dev / ELLIE-541",
      decision_log: "Chose primeWorkingMemoryCache over inline wiring.",
      resumption_prompt: "Resume from test 8.",
    } });

    await primeWorkingMemoryCache(session_id, agent);

    const result = buildPrompt(
      "Fix it",
      undefined, undefined, undefined, "telegram", { name: agent },
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, true, // fullWorkingMemory
    );

    expect(result).toContain("WORKING MEMORY — dev:");
    expect(result).toContain("**Session:** dev / ELLIE-541");
    expect(result).toContain("**Decisions:**");
    expect(result).toContain("Chose primeWorkingMemoryCache over inline wiring.");
    expect(result).toContain("**Resumption:** Resume from test 8.");
  });

  test("prompt unaffected by null session_id (no injection)", async () => {
    await primeWorkingMemoryCache(null, "dev");
    const result = buildPrompt("Hello", undefined, undefined, undefined, "telegram", { name: "dev" });
    expect(result).not.toContain("RESUMPTION CONTEXT:");
  });
});
