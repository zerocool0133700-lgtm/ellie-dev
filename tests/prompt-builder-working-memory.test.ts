/**
 * ELLIE-539 — Working memory prompt-builder integration tests
 *
 * Tests that buildPrompt() correctly injects working memory sections.
 * Uses _injectWorkingMemoryForTesting() to control cache state — no DB needed.
 *
 * Coverage:
 *   - Resumption prompt always injected when present (no fullWorkingMemory flag)
 *   - Resumption prompt absent when working memory cache is empty
 *   - Full working memory injected only when fullWorkingMemory=true
 *   - Full section includes all non-empty section fields
 *   - Empty sections are omitted from full working memory output
 *   - Working memory absent for general agent when only dev agent cache is set
 *   - Metrics: section labels correct (working-memory-resumption vs working-memory-full)
 *   - Priority 2 — working memory appears before protocols (priority 3)
 *   - clearWorkingMemoryCache() removes all injected records
 *   - Different agents get their own independent cache entries
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  buildPrompt,
  getLastBuildMetrics,
  clearWorkingMemoryCache,
  _injectWorkingMemoryForTesting,
  stopPersonalityWatchers,
  clearRiverDocCache,
} from "../src/prompt-builder.ts";

// ── Cleanup ───────────────────────────────────────────────────────────────────

afterAll(() => {
  stopPersonalityWatchers();
  clearWorkingMemoryCache();
  clearRiverDocCache();
});

beforeEach(() => {
  clearWorkingMemoryCache();
  clearRiverDocCache();
});

// ── Shared test fixtures ──────────────────────────────────────────────────────

const DEV_AGENT = { system_prompt: "You are a dev agent.", name: "dev" };
const RESEARCH_AGENT = { name: "research" };
const GENERAL_AGENT = { name: "general" };

const RESUMPTION = "Pick up from step 3: fixing the auth bug in relay.ts:42. The JWT decode was throwing on malformed tokens.";
const TASK_STACK = "1. [DONE] Read relay.ts\n2. [ACTIVE] Fix JWT decode bug\n3. [ ] Write tests\n4. [ ] Commit";
const DECISION_LOG = "Chose try/catch around jwt.decode() over a regex validator because it handles all malformed cases cleanly.";
const CONTEXT_ANCHORS = "relay.ts:42 — jwt.decode() throws on malformed input. Error: 'invalid signature'. Node version: 20.x";
const INVESTIGATION = "Hypothesis: JWT bug introduced in commit abc123. Files read: relay.ts, auth.ts, jwt-utils.ts.";
const CONV_THREAD = "Started debugging JWT auth failures reported by Dave. Found the decode throws synchronously on bad input.";

// ── resumption_prompt — always injected ──────────────────────────────────────

describe("buildPrompt — resumption prompt always injected (ELLIE-539)", () => {
  test("injects resumption_prompt into prompt when present", () => {
    _injectWorkingMemoryForTesting("general", { resumption_prompt: RESUMPTION });
    const result = buildPrompt("Hello");
    expect(result).toContain(RESUMPTION);
    expect(result).toContain("RESUMPTION CONTEXT:");
  });

  test("injects resumption_prompt for dev agent", () => {
    _injectWorkingMemoryForTesting("dev", { resumption_prompt: RESUMPTION });
    const result = buildPrompt("Fix it", undefined, undefined, undefined, "telegram", DEV_AGENT);
    expect(result).toContain(RESUMPTION);
    expect(result).toContain("RESUMPTION CONTEXT:");
  });

  test("absent when working memory cache is empty", () => {
    const result = buildPrompt("Hello");
    expect(result).not.toContain("RESUMPTION CONTEXT:");
    expect(result).not.toContain("WORKING MEMORY");
  });

  test("absent when resumption_prompt is empty string", () => {
    _injectWorkingMemoryForTesting("general", { resumption_prompt: "" });
    const result = buildPrompt("Hello");
    expect(result).not.toContain("RESUMPTION CONTEXT:");
  });

  test("absent when resumption_prompt is whitespace only", () => {
    _injectWorkingMemoryForTesting("general", { resumption_prompt: "   " });
    const result = buildPrompt("Hello");
    expect(result).not.toContain("RESUMPTION CONTEXT:");
  });

  test("absent when only other sections are present (no resumption_prompt)", () => {
    _injectWorkingMemoryForTesting("general", { task_stack: TASK_STACK });
    const result = buildPrompt("Hello");
    expect(result).not.toContain("RESUMPTION CONTEXT:");
    expect(result).not.toContain("WORKING MEMORY");
  });

  test("resumption_prompt NOT injected as full block when fullWorkingMemory is false", () => {
    _injectWorkingMemoryForTesting("general", {
      resumption_prompt: RESUMPTION,
      task_stack: TASK_STACK,
    });
    const result = buildPrompt("Hello", undefined, undefined, undefined, "telegram", undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, false);
    expect(result).toContain("RESUMPTION CONTEXT:");
    expect(result).not.toContain("WORKING MEMORY —");
    expect(result).not.toContain("**Tasks:**");
  });
});

// ── fullWorkingMemory=true — full section injected ────────────────────────────

describe("buildPrompt — fullWorkingMemory=true (ELLIE-539)", () => {
  test("injects WORKING MEMORY header with all present sections", () => {
    _injectWorkingMemoryForTesting("dev", {
      session_identity: "dev / ELLIE-539 / ellie-chat",
      task_stack: TASK_STACK,
      conversation_thread: CONV_THREAD,
      investigation_state: INVESTIGATION,
      decision_log: DECISION_LOG,
      context_anchors: CONTEXT_ANCHORS,
      resumption_prompt: RESUMPTION,
    });

    const result = buildPrompt(
      "Fix it",
      undefined, undefined, undefined, "telegram", DEV_AGENT,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, true, // fullWorkingMemory
    );

    expect(result).toContain("WORKING MEMORY — dev:");
    expect(result).toContain("**Session:** dev / ELLIE-539 / ellie-chat");
    expect(result).toContain("**Tasks:**");
    expect(result).toContain(TASK_STACK);
    expect(result).toContain("**Thread:**");
    expect(result).toContain("**Investigation:**");
    expect(result).toContain("**Decisions:**");
    expect(result).toContain(DECISION_LOG);
    expect(result).toContain("**Anchors:**");
    expect(result).toContain("**Resumption:**");
    expect(result).toContain(RESUMPTION);
  });

  test("omits empty sections from full working memory", () => {
    _injectWorkingMemoryForTesting("dev", {
      session_identity: "dev / ELLIE-539",
      // No task_stack, conversation_thread, investigation_state
      decision_log: DECISION_LOG,
      // No context_anchors, resumption_prompt
    });

    const result = buildPrompt(
      "Fix it",
      undefined, undefined, undefined, "telegram", DEV_AGENT,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, true,
    );

    expect(result).toContain("WORKING MEMORY — dev:");
    expect(result).toContain("**Session:** dev / ELLIE-539");
    expect(result).toContain("**Decisions:**");
    // Absent sections should not appear
    expect(result).not.toContain("**Tasks:**");
    expect(result).not.toContain("**Thread:**");
    expect(result).not.toContain("**Investigation:**");
    expect(result).not.toContain("**Anchors:**");
    expect(result).not.toContain("**Resumption:**");
  });

  test("no WORKING MEMORY block when all sections are empty and fullWorkingMemory=true", () => {
    _injectWorkingMemoryForTesting("general", {}); // empty sections

    const result = buildPrompt(
      "Hello",
      undefined, undefined, undefined, "telegram", undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, true,
    );

    expect(result).not.toContain("WORKING MEMORY");
  });

  test("full block uses agent name in header", () => {
    _injectWorkingMemoryForTesting("research", { decision_log: "Chose primary sources over secondary." });

    const result = buildPrompt(
      "Research this",
      undefined, undefined, undefined, "telegram", RESEARCH_AGENT,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, true,
    );

    expect(result).toContain("WORKING MEMORY — research:");
  });
});

// ── Cache isolation — agents don't bleed into each other ─────────────────────

describe("buildPrompt — working memory cache isolation", () => {
  test("dev agent cache does not appear in general agent prompt", () => {
    _injectWorkingMemoryForTesting("dev", { resumption_prompt: "DEV RESUMPTION" });
    const result = buildPrompt("Hello"); // general agent, no config
    expect(result).not.toContain("DEV RESUMPTION");
    expect(result).not.toContain("RESUMPTION CONTEXT:");
  });

  test("general agent cache does not appear in dev agent prompt", () => {
    _injectWorkingMemoryForTesting("general", { resumption_prompt: "GENERAL RESUMPTION" });
    const result = buildPrompt("Fix it", undefined, undefined, undefined, "telegram", DEV_AGENT);
    expect(result).not.toContain("GENERAL RESUMPTION");
  });

  test("each agent gets its own resumption prompt", () => {
    _injectWorkingMemoryForTesting("dev", { resumption_prompt: "DEV: resume from step 5" });
    _injectWorkingMemoryForTesting("research", { resumption_prompt: "RESEARCH: resume from query 3" });

    const devResult = buildPrompt("Fix it", undefined, undefined, undefined, "telegram", DEV_AGENT);
    const researchResult = buildPrompt("Research this", undefined, undefined, undefined, "telegram", RESEARCH_AGENT);

    expect(devResult).toContain("DEV: resume from step 5");
    expect(devResult).not.toContain("RESEARCH: resume from query 3");
    expect(researchResult).toContain("RESEARCH: resume from query 3");
    expect(researchResult).not.toContain("DEV: resume from step 5");
  });
});

// ── clearWorkingMemoryCache ───────────────────────────────────────────────────

describe("clearWorkingMemoryCache", () => {
  test("clears injected working memory", () => {
    _injectWorkingMemoryForTesting("general", { resumption_prompt: RESUMPTION });
    clearWorkingMemoryCache();
    const result = buildPrompt("Hello");
    expect(result).not.toContain(RESUMPTION);
    expect(result).not.toContain("RESUMPTION CONTEXT:");
  });

  test("safe to call on empty cache", () => {
    expect(() => clearWorkingMemoryCache()).not.toThrow();
  });

  test("can be called multiple times", () => {
    clearWorkingMemoryCache();
    clearWorkingMemoryCache();
    const result = buildPrompt("Hello");
    expect(result).not.toContain("RESUMPTION CONTEXT:");
  });
});

// ── Build metrics — section labels ───────────────────────────────────────────

describe("buildPrompt — working memory section labels in metrics (ELLIE-539)", () => {
  test("metrics show 'working-memory-resumption' label when resumption only", () => {
    _injectWorkingMemoryForTesting("general", { resumption_prompt: RESUMPTION });
    buildPrompt("Hello");
    const metrics = getLastBuildMetrics()!;
    const section = metrics.sections.find(s => s.label === "working-memory-resumption");
    expect(section).toBeDefined();
  });

  test("metrics do NOT show 'working-memory-full' when fullWorkingMemory is false/omitted", () => {
    _injectWorkingMemoryForTesting("general", { resumption_prompt: RESUMPTION, task_stack: TASK_STACK });
    buildPrompt("Hello");
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label === "working-memory-full")).toBeUndefined();
  });

  test("metrics show 'working-memory-full' when fullWorkingMemory=true", () => {
    _injectWorkingMemoryForTesting("dev", { decision_log: DECISION_LOG, resumption_prompt: RESUMPTION });
    buildPrompt(
      "Fix it",
      undefined, undefined, undefined, "telegram", DEV_AGENT,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, true,
    );
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label === "working-memory-full")).toBeDefined();
    expect(metrics.sections.find(s => s.label === "working-memory-resumption")).toBeUndefined();
  });

  test("no working memory section in metrics when cache is empty", () => {
    buildPrompt("Hello");
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label?.startsWith("working-memory"))).toBeUndefined();
  });

  test("working-memory-resumption section has priority 2", () => {
    _injectWorkingMemoryForTesting("general", { resumption_prompt: RESUMPTION });
    buildPrompt("Hello");
    const metrics = getLastBuildMetrics()!;
    const section = metrics.sections.find(s => s.label === "working-memory-resumption");
    expect(section?.priority).toBe(2);
  });
});

// ── Priority ordering — working memory appears before protocols ───────────────

describe("buildPrompt — working memory priority ordering (ELLIE-539)", () => {
  test("resumption_prompt appears before memory-protocol in prompt", () => {
    _injectWorkingMemoryForTesting("general", { resumption_prompt: "RESUMPTION_MARKER" });
    // Also inject memory-protocol so it appears too
    const { _injectRiverDocForTesting } = require("../src/prompt-builder.ts");
    _injectRiverDocForTesting("memory-protocol", "MEMORY_PROTOCOL_MARKER");

    const result = buildPrompt("Hello");
    const resumptionIdx = result.indexOf("RESUMPTION_MARKER");
    const protocolIdx = result.indexOf("MEMORY_PROTOCOL_MARKER");

    expect(resumptionIdx).toBeGreaterThan(-1);
    expect(protocolIdx).toBeGreaterThan(-1);
    // Priority 2 (resumption) should come before priority 3 (protocols)
    expect(resumptionIdx).toBeLessThan(protocolIdx);
  });
});
