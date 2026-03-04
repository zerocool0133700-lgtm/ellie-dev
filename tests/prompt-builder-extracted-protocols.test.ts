/**
 * ELLIE-536 — Extract remaining hardcoded protocols to River vault
 *
 * Tests the River-backed versions of the four protocols extracted in ELLIE-536:
 *   - forest-writes   → forest-memory-writes section (gated on sessionIds)
 *   - playbook-commands → playbook-commands section (general agent + Plane configured)
 *   - work-commands   → work-commands section (all agents + Plane configured)
 *   - planning-mode   → planning-mode section (gated on planningMode)
 *
 * Each covers: key registration, River content returned, hardcoded fallback,
 * gating condition, section_priority from frontmatter, and BuildMetrics tracking.
 * No module mocking — uses _injectRiverDocForTesting() to control cache state.
 */

// Note: PLANE_API_KEY is always set via .env, so isPlaneConfigured() returns true in tests.
// playbook-commands and work-commands sections are included in every buildPrompt call.

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  buildPrompt,
  getLastBuildMetrics,
  getCachedRiverDoc,
  clearRiverDocCache,
  setRiverDocCacheTtl,
  getRiverDocMetrics,
  _injectRiverDocForTesting,
  _resetRiverMetricsForTesting,
  setPlanningMode,
  stopPersonalityWatchers,
} from "../src/prompt-builder.ts";

// ── Cleanup ────────────────────────────────────────────────────────────────────

afterAll(() => {
  stopPersonalityWatchers();
  clearRiverDocCache();
  setRiverDocCacheTtl(60_000);
  _resetRiverMetricsForTesting();
  setPlanningMode(false);
});

beforeEach(() => {
  clearRiverDocCache();
  setRiverDocCacheTtl(60_000);
  _resetRiverMetricsForTesting();
  setPlanningMode(false);
});

// ── Shared helpers ──────────────────────────────────────────────────────────────

const SESSION_IDS = {
  tree_id: "t-ellie-536",
  branch_id: "b1",
  creature_id: "c1",
  entity_id: "e1",
};

function buildWithSession(extra?: Parameters<typeof buildPrompt>[5]): string {
  return buildPrompt(
    "Hello",
    undefined, undefined, undefined, "telegram",
    extra,
    undefined, undefined, undefined, undefined, undefined, undefined,
    SESSION_IDS,
  );
}

function buildGeneral(): string {
  return buildPrompt("Hello");
}

function buildDownstream(agentName: string): string {
  return buildPrompt(
    "Hello", undefined, undefined, undefined, "telegram",
    { system_prompt: `You are a ${agentName} agent.`, name: agentName },
  );
}

// ── RIVER_DOC_PATHS key registration ──────────────────────────────────────────

describe("RIVER_DOC_PATHS — ELLIE-536 keys registered", () => {
  test("getCachedRiverDoc('forest-writes') returns null on cold cache (key exists)", () => {
    expect(getCachedRiverDoc("forest-writes")).toBeNull();
    expect(getRiverDocMetrics().cacheMisses).toBeGreaterThanOrEqual(1);
  });

  test("getCachedRiverDoc('playbook-commands') returns null on cold cache (key exists)", () => {
    expect(getCachedRiverDoc("playbook-commands")).toBeNull();
    expect(getRiverDocMetrics().cacheMisses).toBeGreaterThanOrEqual(1);
  });

  test("getCachedRiverDoc('work-commands') returns null on cold cache (key exists)", () => {
    expect(getCachedRiverDoc("work-commands")).toBeNull();
    expect(getRiverDocMetrics().cacheMisses).toBeGreaterThanOrEqual(1);
  });

  test("getCachedRiverDoc('planning-mode') returns null on cold cache (key exists)", () => {
    expect(getCachedRiverDoc("planning-mode")).toBeNull();
    expect(getRiverDocMetrics().cacheMisses).toBeGreaterThanOrEqual(1);
  });

  test("_injectRiverDocForTesting roundtrip for all four keys", () => {
    _injectRiverDocForTesting("forest-writes", "Forest writes content");
    _injectRiverDocForTesting("playbook-commands", "Playbook content");
    _injectRiverDocForTesting("work-commands", "Work commands content");
    _injectRiverDocForTesting("planning-mode", "Planning mode content");
    expect(getCachedRiverDoc("forest-writes")).toBe("Forest writes content");
    expect(getCachedRiverDoc("playbook-commands")).toBe("Playbook content");
    expect(getCachedRiverDoc("work-commands")).toBe("Work commands content");
    expect(getCachedRiverDoc("planning-mode")).toBe("Planning mode content");
  });
});

// ── forest-memory-writes section ──────────────────────────────────────────────

describe("forest-memory-writes — River-backed (ELLIE-536)", () => {
  test("River content used when injected and sessionIds provided", () => {
    _injectRiverDocForTesting("forest-writes", "River forest write instructions");
    const result = buildWithSession();
    expect(result).toContain("FOREST MEMORY WRITES (IMPORTANT):");
    expect(result).toContain("River forest write instructions");
  });

  test("River content does NOT contain hardcoded [MEMORY:decision:] example when River injected", () => {
    _injectRiverDocForTesting("forest-writes", "Custom forest protocol");
    const result = buildWithSession();
    expect(result).toContain("Custom forest protocol");
    expect(result).not.toContain("Using Redis for caching");
  });

  test("hardcoded fallback used when cache empty and sessionIds provided", () => {
    const result = buildWithSession();
    expect(result).toContain("FOREST MEMORY WRITES (IMPORTANT):");
    expect(result).toContain("[MEMORY:");
    expect(result).toContain("active forest session");
  });

  test("hardcoded fallback contains format documentation", () => {
    const result = buildWithSession();
    expect(result).toContain("Types: finding, decision, hypothesis, fact, pattern");
    expect(result).toContain("Confidence: 0.6");
  });

  test("section omitted when no sessionIds (gating preserved)", () => {
    _injectRiverDocForTesting("forest-writes", "River forest write instructions");
    const result = buildGeneral();
    expect(result).not.toContain("FOREST MEMORY WRITES");
  });

  test("section omitted when no sessionIds and cache empty (hardcoded fallback also gated)", () => {
    const result = buildGeneral();
    expect(result).not.toContain("FOREST MEMORY WRITES");
  });

  test("River content included for non-general agents with sessionIds", () => {
    _injectRiverDocForTesting("forest-writes", "Forest writes for dev");
    const result = buildPrompt(
      "Fix it", undefined, undefined, undefined, "telegram",
      { system_prompt: "You are a dev agent.", name: "dev" },
      "ACTIVE WORK ITEM: ELLIE-1 | Fix bug",
      undefined, undefined, undefined, undefined, undefined,
      SESSION_IDS,
    );
    expect(result).toContain("FOREST MEMORY WRITES (IMPORTANT):");
    expect(result).toContain("Forest writes for dev");
  });

  test("section label is forest-memory-writes in BuildMetrics", () => {
    _injectRiverDocForTesting("forest-writes", "River content");
    buildWithSession();
    const metrics = getLastBuildMetrics()!;
    const section = metrics.sections.find(s => s.label === "forest-memory-writes");
    expect(section).toBeDefined();
  });

  test("River hit counted in BuildMetrics when forest-writes injected", () => {
    _injectRiverDocForTesting("forest-writes", "River content");
    buildWithSession();
    const metrics = getLastBuildMetrics()!;
    expect(metrics.riverCacheHits).toBeGreaterThanOrEqual(1);
  });

  test("section_priority from frontmatter overrides default 3", () => {
    _injectRiverDocForTesting("forest-writes", "Body content", { section_priority: 5 });
    buildWithSession();
    const metrics = getLastBuildMetrics()!;
    const section = metrics.sections.find(s => s.label === "forest-memory-writes");
    expect(section?.priority).toBe(5);
  });
});

// ── playbook-commands section ─────────────────────────────────────────────────

describe("playbook-commands — River-backed (ELLIE-536)", () => {
  test("River content used when injected and general agent", () => {
    _injectRiverDocForTesting("playbook-commands", "River playbook instructions");
    const result = buildGeneral();
    expect(result).toContain("ELLIE:: PLAYBOOK COMMANDS:");
    expect(result).toContain("River playbook instructions");
  });

  test("River content does NOT contain hardcoded ELLIE:: send example when River injected", () => {
    _injectRiverDocForTesting("playbook-commands", "Custom playbook protocol");
    const result = buildGeneral();
    expect(result).toContain("Custom playbook protocol");
    expect(result).not.toContain("ELLIE-144");
  });

  test("hardcoded fallback used when cache empty", () => {
    const result = buildGeneral();
    expect(result).toContain("ELLIE:: PLAYBOOK COMMANDS:");
    expect(result).toContain("ELLIE:: send ELLIE-144 to dev");
  });

  test("hardcoded fallback contains all three command examples", () => {
    const result = buildGeneral();
    expect(result).toContain("ELLIE:: send ELLIE-144 to dev");
    expect(result).toContain("ELLIE:: close ELLIE-144");
    expect(result).toContain("ELLIE:: create ticket");
  });

  test("section omitted for downstream agents (general agent only)", () => {
    _injectRiverDocForTesting("playbook-commands", "River playbook");
    const result = buildDownstream("dev");
    expect(result).not.toContain("ELLIE:: PLAYBOOK COMMANDS:");
  });

  test("section omitted for research agent", () => {
    _injectRiverDocForTesting("playbook-commands", "River playbook");
    const result = buildDownstream("research");
    expect(result).not.toContain("ELLIE:: PLAYBOOK COMMANDS:");
  });

  test("section omitted for strategy agent", () => {
    _injectRiverDocForTesting("playbook-commands", "River playbook");
    const result = buildDownstream("strategy");
    expect(result).not.toContain("ELLIE:: PLAYBOOK COMMANDS:");
  });

  test("section label is playbook-commands in BuildMetrics", () => {
    _injectRiverDocForTesting("playbook-commands", "River content");
    buildGeneral();
    const metrics = getLastBuildMetrics()!;
    const section = metrics.sections.find(s => s.label === "playbook-commands");
    expect(section).toBeDefined();
  });

  test("River hit counted in BuildMetrics when playbook-commands injected", () => {
    _injectRiverDocForTesting("playbook-commands", "River content");
    buildGeneral();
    const metrics = getLastBuildMetrics()!;
    expect(metrics.riverCacheHits).toBeGreaterThanOrEqual(1);
  });

  test("section_priority from frontmatter overrides default 3", () => {
    _injectRiverDocForTesting("playbook-commands", "Body", { section_priority: 4 });
    buildGeneral();
    const metrics = getLastBuildMetrics()!;
    const section = metrics.sections.find(s => s.label === "playbook-commands");
    expect(section?.priority).toBe(4);
  });
});

// ── work-commands section ─────────────────────────────────────────────────────

describe("work-commands — River-backed (ELLIE-536)", () => {
  test("River content used when injected", () => {
    _injectRiverDocForTesting("work-commands", "River work commands");
    const result = buildGeneral();
    expect(result).toContain("WORK ITEM COMMANDS:");
    expect(result).toContain("River work commands");
  });

  test("River content does NOT contain hardcoded mcp__plane__ reference when River injected", () => {
    _injectRiverDocForTesting("work-commands", "Custom work commands protocol");
    const result = buildGeneral();
    expect(result).toContain("Custom work commands protocol");
    expect(result).not.toContain("mcp__plane__list_states");
  });

  test("hardcoded fallback used when cache empty", () => {
    const result = buildGeneral();
    expect(result).toContain("WORK ITEM COMMANDS:");
    expect(result).toContain("mcp__plane__list_states");
  });

  test("hardcoded fallback contains ELLIE-N prefix instruction", () => {
    const result = buildGeneral();
    expect(result).toContain("[ELLIE-N] prefix");
  });

  test("section appears for downstream agents too (not gated by agent type)", () => {
    _injectRiverDocForTesting("work-commands", "River work commands");
    const result = buildDownstream("dev");
    expect(result).toContain("WORK ITEM COMMANDS:");
  });

  test("section appears for research agent", () => {
    _injectRiverDocForTesting("work-commands", "River work commands");
    const result = buildDownstream("research");
    expect(result).toContain("WORK ITEM COMMANDS:");
  });

  test("section label is work-commands in BuildMetrics", () => {
    _injectRiverDocForTesting("work-commands", "River content");
    buildGeneral();
    const metrics = getLastBuildMetrics()!;
    const section = metrics.sections.find(s => s.label === "work-commands");
    expect(section).toBeDefined();
  });

  test("River hit counted in BuildMetrics when work-commands injected", () => {
    _injectRiverDocForTesting("work-commands", "River content");
    buildGeneral();
    const metrics = getLastBuildMetrics()!;
    expect(metrics.riverCacheHits).toBeGreaterThanOrEqual(1);
  });

  test("section_priority from frontmatter overrides default 3", () => {
    _injectRiverDocForTesting("work-commands", "Body", { section_priority: 4 });
    buildGeneral();
    const metrics = getLastBuildMetrics()!;
    const section = metrics.sections.find(s => s.label === "work-commands");
    expect(section?.priority).toBe(4);
  });
});

// ── planning-mode section ─────────────────────────────────────────────────────

describe("planning-mode — River-backed (ELLIE-536)", () => {
  test("River content used when injected and planningMode active", () => {
    _injectRiverDocForTesting("planning-mode", "River planning mode instructions");
    setPlanningMode(true);
    const result = buildGeneral();
    expect(result).toContain("PLANNING MODE ACTIVE:");
    expect(result).toContain("River planning mode instructions");
  });

  test("River content does NOT contain hardcoded 'extended planning session' when River injected", () => {
    _injectRiverDocForTesting("planning-mode", "Custom planning protocol");
    setPlanningMode(true);
    const result = buildGeneral();
    expect(result).toContain("Custom planning protocol");
    expect(result).not.toContain("extended planning session");
  });

  test("hardcoded fallback used when cache empty and planningMode active", () => {
    setPlanningMode(true);
    const result = buildGeneral();
    expect(result).toContain("PLANNING MODE ACTIVE:");
    expect(result).toContain("extended planning session");
  });

  test("hardcoded fallback contains continuity instruction", () => {
    setPlanningMode(true);
    const result = buildGeneral();
    expect(result).toContain("Maintain continuity and context across messages");
    expect(result).toContain("deactivate planning mode when done");
  });

  test("section omitted when planningMode is false (gating preserved)", () => {
    _injectRiverDocForTesting("planning-mode", "River planning mode");
    const result = buildGeneral(); // planningMode is false (reset in beforeEach)
    expect(result).not.toContain("PLANNING MODE ACTIVE:");
  });

  test("section omitted when cache empty and planningMode false", () => {
    const result = buildGeneral();
    expect(result).not.toContain("PLANNING MODE ACTIVE:");
  });

  test("section label is planning-mode in BuildMetrics when active", () => {
    _injectRiverDocForTesting("planning-mode", "River content");
    setPlanningMode(true);
    buildGeneral();
    const metrics = getLastBuildMetrics()!;
    const section = metrics.sections.find(s => s.label === "planning-mode");
    expect(section).toBeDefined();
  });

  test("section absent from BuildMetrics when planning mode off", () => {
    _injectRiverDocForTesting("planning-mode", "River content");
    buildGeneral(); // planningMode false
    const metrics = getLastBuildMetrics()!;
    const section = metrics.sections.find(s => s.label === "planning-mode");
    expect(section).toBeUndefined();
  });

  test("River hit counted in BuildMetrics when planning-mode injected and active", () => {
    _injectRiverDocForTesting("planning-mode", "River content");
    setPlanningMode(true);
    buildGeneral();
    const metrics = getLastBuildMetrics()!;
    expect(metrics.riverCacheHits).toBeGreaterThanOrEqual(1);
  });

  test("section_priority from frontmatter overrides default 3", () => {
    _injectRiverDocForTesting("planning-mode", "Body", { section_priority: 2 });
    setPlanningMode(true);
    buildGeneral();
    const metrics = getLastBuildMetrics()!;
    const section = metrics.sections.find(s => s.label === "planning-mode");
    expect(section?.priority).toBe(2);
  });
});

// ── Integration: all four new keys contribute to cache metrics ────────────────

describe("Integration — all four ELLIE-536 River keys", () => {
  test("all four keys hit when injected in a build with sessionIds and planningMode", () => {
    _injectRiverDocForTesting("forest-writes", "Forest writes");
    _injectRiverDocForTesting("playbook-commands", "Playbook");
    _injectRiverDocForTesting("work-commands", "Work commands");
    _injectRiverDocForTesting("planning-mode", "Planning mode");
    setPlanningMode(true);
    buildWithSession();
    // All four new keys are hits — plus the existing River keys (memory-protocol, confirm-protocol etc. are misses)
    const metrics = getLastBuildMetrics()!;
    // At least 4 new hits from the injected keys
    expect(metrics.riverCacheHits).toBeGreaterThanOrEqual(4);
  });

  test("section headers appear for all four when River content injected", () => {
    _injectRiverDocForTesting("forest-writes", "Forest writes content");
    _injectRiverDocForTesting("playbook-commands", "Playbook content");
    _injectRiverDocForTesting("work-commands", "Work commands content");
    _injectRiverDocForTesting("planning-mode", "Planning mode content");
    setPlanningMode(true);
    const result = buildWithSession();
    expect(result).toContain("FOREST MEMORY WRITES (IMPORTANT):");
    expect(result).toContain("ELLIE:: PLAYBOOK COMMANDS:");
    expect(result).toContain("WORK ITEM COMMANDS:");
    expect(result).toContain("PLANNING MODE ACTIVE:");
  });

  test("hardcoded fallbacks provide all four section headers when cache empty", () => {
    setPlanningMode(true);
    const result = buildWithSession();
    expect(result).toContain("FOREST MEMORY WRITES (IMPORTANT):");
    expect(result).toContain("ELLIE:: PLAYBOOK COMMANDS:");
    expect(result).toContain("WORK ITEM COMMANDS:");
    expect(result).toContain("PLANNING MODE ACTIVE:");
  });

  test("global cacheHits accumulates when same keys are looked up across builds", () => {
    _injectRiverDocForTesting("forest-writes", "FW");
    _injectRiverDocForTesting("work-commands", "WC");
    buildWithSession();
    buildWithSession();
    const { cacheHits } = getRiverDocMetrics();
    // Each build hits forest-writes + work-commands (+ others already injected)
    expect(cacheHits).toBeGreaterThanOrEqual(4);
  });
});
