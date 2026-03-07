/**
 * Prompt-builder agent protocol tests
 * Consolidated from ELLIE-533 (dev), ELLIE-535 (research/strategy), ELLIE-536/537 (extracted protocols)
 * as part of ELLIE-560.
 *
 * Tests agent-specific prompt protocol sections and their River-backed behavior:
 *   - Dev agent protocol: River template, work item gating, section_priority
 *   - Research agent protocol: River template, agent gating, section_priority
 *   - Strategy agent protocol: River template, agent gating, section_priority
 *   - Protocol isolation: each agent only gets its own protocol section
 *   - Extracted protocols: forest-writes, playbook-commands, work-commands, planning-mode
 *   - All-River integration tests
 *
 * No module mocking — uses _injectRiverDocForTesting() to control cache state.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  buildPrompt,
  getLastBuildMetrics,
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

// ── Constants ──────────────────────────────────────────────────────────────────

const DEV_AGENT_CONFIG = { system_prompt: "You are a dev specialist.", name: "dev" };
const RESEARCH_AGENT_CONFIG = { system_prompt: "You are a research agent.", name: "research" };
const STRATEGY_AGENT_CONFIG = { system_prompt: "You are a strategy agent.", name: "strategy" };
const ACTIVE_WORK_ITEM = "ACTIVE WORK ITEM: ELLIE-533 — Agent protocol tests";

const RIVER_DEV_TEMPLATE =
  "1. Read the ticket and understand requirements\n" +
  "2. Implement code changes\n" +
  "3. Commit with [ELLIE-N] prefix\n" +
  "4. Verify changes work";

const SESSION_IDS = {
  tree_id: "t-test",
  branch_id: "b1",
  creature_id: "c1",
  entity_id: "e1",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildWithSession(extra?: Parameters<typeof buildPrompt>[5]): string {
  return buildPrompt(
    "Hello", undefined, undefined, undefined, "telegram",
    extra,
    undefined, undefined, undefined, undefined, undefined, undefined,
    SESSION_IDS,
  );
}

function buildGeneral(): string {
  return buildPrompt("Hello");
}

function buildDownstream(name: string): string {
  return buildPrompt(
    "Hello", undefined, undefined, undefined, "telegram",
    { system_prompt: `You are a ${name} agent.`, name },
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// DEV AGENT PROTOCOL
// ════════════════════════════════════════════════════════════════════════════════

describe("dev agent — River-backed dev-agent-template", () => {
  test("River template content appears in prompt when cached", () => {
    _injectRiverDocForTesting("dev-agent-template", RIVER_DEV_TEMPLATE);
    const result = buildPrompt(
      "Fix the bug", undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
    );
    expect(result).toContain("DEV AGENT PROTOCOL:");
    expect(result).toContain(RIVER_DEV_TEMPLATE);
  });

  test("River template replaces hardcoded protocol entirely", () => {
    _injectRiverDocForTesting("dev-agent-template", "CUSTOM: step-a, step-b");
    const result = buildPrompt(
      "Fix it", undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
    );
    expect(result).toContain("CUSTOM: step-a, step-b");
  });

  test("dev-protocol section present in metrics when River template loaded", () => {
    _injectRiverDocForTesting("dev-agent-template", RIVER_DEV_TEMPLATE);
    buildPrompt("Fix", undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM);
    const labels = getLastBuildMetrics()!.sections.map(s => s.label);
    expect(labels).toContain("dev-protocol");
  });
});

describe("dev agent — section absent when River empty (ELLIE-537)", () => {
  test("DEV AGENT PROTOCOL absent when cache empty", () => {
    const result = buildPrompt(
      "Fix the bug", undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
    );
    expect(result).not.toContain("DEV AGENT PROTOCOL:");
  });
});

describe("dev agent — River protocol docs in dev context", () => {
  test("River memory-protocol appears in dev agent prompt", () => {
    _injectRiverDocForTesting("memory-protocol", "DEV MEMORY OVERRIDE");
    const result = buildPrompt("Fix", undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM);
    expect(result).toContain("DEV MEMORY OVERRIDE");
    expect(result).toContain("MEMORY MANAGEMENT:");
  });

  test("River confirm-protocol appears in dev agent prompt", () => {
    _injectRiverDocForTesting("confirm-protocol", "DEV CONFIRM OVERRIDE");
    const result = buildPrompt("Fix", undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM);
    expect(result).toContain("DEV CONFIRM OVERRIDE");
    expect(result).toContain("ACTION CONFIRMATIONS:");
  });

  test("protocols absent in dev agent when River cache empty (ELLIE-537)", () => {
    const result = buildPrompt("Fix", undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM);
    expect(result).not.toContain("MEMORY MANAGEMENT:");
    expect(result).not.toContain("ACTION CONFIRMATIONS:");
  });
});

describe("dev agent — frontmatter section_priority", () => {
  test("dev-protocol uses frontmatter section_priority when set", () => {
    _injectRiverDocForTesting("dev-agent-template", "Steps", { section_priority: 4 });
    buildPrompt("Fix", undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM);
    const section = getLastBuildMetrics()!.sections.find(s => s.label === "dev-protocol");
    expect(section!.priority).toBe(4);
  });

  test("dev-protocol defaults to priority 3 when no frontmatter", () => {
    _injectRiverDocForTesting("dev-agent-template", "Steps");
    buildPrompt("Fix", undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM);
    const section = getLastBuildMetrics()!.sections.find(s => s.label === "dev-protocol");
    expect(section!.priority).toBe(3);
  });

  test("section_priority 8 suppresses dev-protocol", () => {
    _injectRiverDocForTesting("dev-agent-template", "SUPPRESSED", { section_priority: 8 });
    const result = buildPrompt("Fix", undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM);
    expect(result).not.toContain("SUPPRESSED");
  });
});

describe("dev agent — dev protocol conditional on work item", () => {
  test("dev-protocol absent when workItemContext lacks trigger phrase", () => {
    _injectRiverDocForTesting("dev-agent-template", RIVER_DEV_TEMPLATE);
    buildPrompt("Fix", undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG,
      "Some other context without the trigger phrase");
    const labels = getLastBuildMetrics()!.sections.map(s => s.label);
    expect(labels).not.toContain("dev-protocol");
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// RESEARCH AGENT PROTOCOL
// ════════════════════════════════════════════════════════════════════════════════

describe("research agent — research-protocol (ELLIE-535)", () => {
  test("uses River research template when injected", () => {
    _injectRiverDocForTesting("research-agent-template", "RIVER RESEARCH: gather, evaluate, synthesize");
    const result = buildPrompt("Research quantum", undefined, undefined, undefined, "telegram", RESEARCH_AGENT_CONFIG);
    expect(result).toContain("RESEARCH AGENT PROTOCOL:");
    expect(result).toContain("RIVER RESEARCH: gather, evaluate, synthesize");
  });

  test("section absent when River cache empty (ELLIE-537)", () => {
    const result = buildPrompt("Research this", undefined, undefined, undefined, "telegram", RESEARCH_AGENT_CONFIG);
    expect(result).not.toContain("RESEARCH AGENT PROTOCOL:");
  });

  test("research-protocol in metrics when River injected", () => {
    _injectRiverDocForTesting("research-agent-template", "Research content");
    buildPrompt("Research", undefined, undefined, undefined, "telegram", { name: "research" });
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "research-protocol")).toBeDefined();
  });

  test("does NOT appear for general agent", () => {
    buildPrompt("Hello");
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "research-protocol")).toBeUndefined();
  });

  test("does NOT appear for dev agent", () => {
    buildPrompt("Fix", undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG);
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "research-protocol")).toBeUndefined();
  });

  test("does NOT appear for strategy agent", () => {
    buildPrompt("Plan", undefined, undefined, undefined, "telegram", { name: "strategy" });
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "research-protocol")).toBeUndefined();
  });

  test("appears without requiring active work item", () => {
    _injectRiverDocForTesting("research-agent-template", "Research content");
    buildPrompt("Research", undefined, undefined, undefined, "telegram", { name: "research" });
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "research-protocol")).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// STRATEGY AGENT PROTOCOL
// ════════════════════════════════════════════════════════════════════════════════

describe("strategy agent — strategy-protocol (ELLIE-535)", () => {
  test("uses River strategy template when injected", () => {
    _injectRiverDocForTesting("strategy-agent-template", "RIVER STRATEGY: assess, plan, decide");
    const result = buildPrompt("Plan Q3", undefined, undefined, undefined, "telegram", STRATEGY_AGENT_CONFIG);
    expect(result).toContain("STRATEGY AGENT PROTOCOL:");
    expect(result).toContain("RIVER STRATEGY: assess, plan, decide");
  });

  test("section absent when River cache empty (ELLIE-537)", () => {
    const result = buildPrompt("Plan", undefined, undefined, undefined, "telegram", STRATEGY_AGENT_CONFIG);
    expect(result).not.toContain("STRATEGY AGENT PROTOCOL:");
  });

  test("strategy-protocol in metrics when River injected", () => {
    _injectRiverDocForTesting("strategy-agent-template", "Strategy content");
    buildPrompt("Plan", undefined, undefined, undefined, "telegram", { name: "strategy" });
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "strategy-protocol")).toBeDefined();
  });

  test("does NOT appear for general agent", () => {
    buildPrompt("Hello");
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "strategy-protocol")).toBeUndefined();
  });

  test("does NOT appear for dev agent", () => {
    buildPrompt("Fix", undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG);
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "strategy-protocol")).toBeUndefined();
  });

  test("does NOT appear for research agent", () => {
    buildPrompt("Research", undefined, undefined, undefined, "telegram", { name: "research" });
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "strategy-protocol")).toBeUndefined();
  });

  test("appears without requiring active work item", () => {
    _injectRiverDocForTesting("strategy-agent-template", "Strategy content");
    buildPrompt("Plan", undefined, undefined, undefined, "telegram", { name: "strategy" });
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "strategy-protocol")).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// PROTOCOL ISOLATION
// ════════════════════════════════════════════════════════════════════════════════

describe("protocol isolation — each agent only gets its own protocol", () => {
  test("research agent does NOT get dev-protocol", () => {
    _injectRiverDocForTesting("research-agent-template", "Research steps");
    buildPrompt("Research", undefined, undefined, undefined, "telegram",
      { name: "research" }, ACTIVE_WORK_ITEM);
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label === "dev-protocol")).toBeUndefined();
    expect(metrics.sections.find(s => s.label === "research-protocol")).toBeDefined();
  });

  test("strategy agent does NOT get dev-protocol", () => {
    _injectRiverDocForTesting("strategy-agent-template", "Strategy steps");
    buildPrompt("Plan", undefined, undefined, undefined, "telegram",
      { name: "strategy" }, ACTIVE_WORK_ITEM);
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label === "dev-protocol")).toBeUndefined();
    expect(metrics.sections.find(s => s.label === "strategy-protocol")).toBeDefined();
  });

  test("dev agent does NOT get research or strategy protocol", () => {
    _injectRiverDocForTesting("dev-agent-template", "Dev steps");
    buildPrompt("Fix", undefined, undefined, undefined, "telegram",
      { name: "dev" }, ACTIVE_WORK_ITEM);
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label === "dev-protocol")).toBeDefined();
    expect(metrics.sections.find(s => s.label === "research-protocol")).toBeUndefined();
    expect(metrics.sections.find(s => s.label === "strategy-protocol")).toBeUndefined();
  });

  test("general agent gets none of the specialist protocols", () => {
    buildPrompt("Hello");
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label === "dev-protocol")).toBeUndefined();
    expect(metrics.sections.find(s => s.label === "research-protocol")).toBeUndefined();
    expect(metrics.sections.find(s => s.label === "strategy-protocol")).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// FRONTMATTER SECTION_PRIORITY — RESEARCH/STRATEGY
// ════════════════════════════════════════════════════════════════════════════════

describe("frontmatter section_priority — research/strategy", () => {
  test("research uses frontmatter priority when set", () => {
    _injectRiverDocForTesting("research-agent-template", "Content", { section_priority: 4 });
    buildPrompt("Research", undefined, undefined, undefined, "telegram", { name: "research" });
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "research-protocol")!.priority).toBe(4);
  });

  test("strategy uses frontmatter priority when set", () => {
    _injectRiverDocForTesting("strategy-agent-template", "Content", { section_priority: 2 });
    buildPrompt("Plan", undefined, undefined, undefined, "telegram", { name: "strategy" });
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "strategy-protocol")!.priority).toBe(2);
  });

  test("research defaults to priority 3", () => {
    _injectRiverDocForTesting("research-agent-template", "Content");
    buildPrompt("Research", undefined, undefined, undefined, "telegram", { name: "research" });
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "research-protocol")!.priority).toBe(3);
  });

  test("strategy defaults to priority 3", () => {
    _injectRiverDocForTesting("strategy-agent-template", "Content");
    buildPrompt("Plan", undefined, undefined, undefined, "telegram", { name: "strategy" });
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "strategy-protocol")!.priority).toBe(3);
  });

  test("priority 8 suppresses research-protocol", () => {
    _injectRiverDocForTesting("research-agent-template", "SUPPRESSED", { section_priority: 8 });
    const result = buildPrompt("Research", undefined, undefined, undefined, "telegram", { name: "research" });
    expect(result).not.toContain("SUPPRESSED");
  });

  test("priority 8 suppresses strategy-protocol", () => {
    _injectRiverDocForTesting("strategy-agent-template", "SUPPRESSED", { section_priority: 8 });
    const result = buildPrompt("Plan", undefined, undefined, undefined, "telegram", { name: "strategy" });
    expect(result).not.toContain("SUPPRESSED");
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// EXTRACTED PROTOCOLS — FOREST-WRITES
// ════════════════════════════════════════════════════════════════════════════════

describe("forest-memory-writes — River-backed (ELLIE-536)", () => {
  test("River content used when injected and sessionIds provided", () => {
    _injectRiverDocForTesting("forest-writes", "River forest write instructions");
    const result = buildWithSession();
    expect(result).toContain("FOREST MEMORY WRITES (IMPORTANT):");
    expect(result).toContain("River forest write instructions");
  });

  test("section absent when River cache empty (ELLIE-537)", () => {
    const result = buildWithSession();
    expect(result).not.toContain("FOREST MEMORY WRITES (IMPORTANT):");
  });

  test("section omitted when no sessionIds (gating preserved)", () => {
    _injectRiverDocForTesting("forest-writes", "River forest write instructions");
    const result = buildGeneral();
    expect(result).not.toContain("FOREST MEMORY WRITES");
  });

  test("included for non-general agents with sessionIds", () => {
    _injectRiverDocForTesting("forest-writes", "Forest writes for dev");
    const result = buildPrompt(
      "Fix it", undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
      undefined, undefined, undefined, undefined, undefined, SESSION_IDS,
    );
    expect(result).toContain("FOREST MEMORY WRITES (IMPORTANT):");
  });

  test("section label in BuildMetrics", () => {
    _injectRiverDocForTesting("forest-writes", "Content");
    buildWithSession();
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "forest-memory-writes")).toBeDefined();
  });

  test("section_priority from frontmatter", () => {
    _injectRiverDocForTesting("forest-writes", "Body", { section_priority: 5 });
    buildWithSession();
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "forest-memory-writes")?.priority).toBe(5);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// EXTRACTED PROTOCOLS — PLAYBOOK-COMMANDS
// ════════════════════════════════════════════════════════════════════════════════

describe("playbook-commands — River-backed (ELLIE-536)", () => {
  test("River content used when injected for general agent", () => {
    _injectRiverDocForTesting("playbook-commands", "River playbook instructions");
    const result = buildGeneral();
    expect(result).toContain("ELLIE:: PLAYBOOK COMMANDS:");
    expect(result).toContain("River playbook instructions");
  });

  test("section absent when River cache empty (ELLIE-537)", () => {
    const result = buildGeneral();
    expect(result).not.toContain("ELLIE:: PLAYBOOK COMMANDS:");
  });

  test("section omitted for downstream agents", () => {
    _injectRiverDocForTesting("playbook-commands", "Playbook");
    expect(buildDownstream("dev")).not.toContain("ELLIE:: PLAYBOOK COMMANDS:");
    expect(buildDownstream("research")).not.toContain("ELLIE:: PLAYBOOK COMMANDS:");
    expect(buildDownstream("strategy")).not.toContain("ELLIE:: PLAYBOOK COMMANDS:");
  });

  test("section label in BuildMetrics", () => {
    _injectRiverDocForTesting("playbook-commands", "Content");
    buildGeneral();
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "playbook-commands")).toBeDefined();
  });

  test("section_priority from frontmatter", () => {
    _injectRiverDocForTesting("playbook-commands", "Body", { section_priority: 4 });
    buildGeneral();
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "playbook-commands")?.priority).toBe(4);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// EXTRACTED PROTOCOLS — WORK-COMMANDS
// ════════════════════════════════════════════════════════════════════════════════

describe("work-commands — River-backed (ELLIE-536)", () => {
  test("River content used when injected", () => {
    _injectRiverDocForTesting("work-commands", "River work commands");
    const result = buildGeneral();
    expect(result).toContain("WORK ITEM COMMANDS:");
    expect(result).toContain("River work commands");
  });

  test("section absent when River cache empty (ELLIE-537)", () => {
    expect(buildGeneral()).not.toContain("WORK ITEM COMMANDS:");
  });

  test("appears for downstream agents too (not gated by agent type)", () => {
    _injectRiverDocForTesting("work-commands", "Work commands");
    expect(buildDownstream("dev")).toContain("WORK ITEM COMMANDS:");
    expect(buildDownstream("research")).toContain("WORK ITEM COMMANDS:");
  });

  test("section label in BuildMetrics", () => {
    _injectRiverDocForTesting("work-commands", "Content");
    buildGeneral();
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "work-commands")).toBeDefined();
  });

  test("section_priority from frontmatter", () => {
    _injectRiverDocForTesting("work-commands", "Body", { section_priority: 4 });
    buildGeneral();
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "work-commands")?.priority).toBe(4);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// EXTRACTED PROTOCOLS — PLANNING-MODE
// ════════════════════════════════════════════════════════════════════════════════

describe("planning-mode — River-backed (ELLIE-536)", () => {
  test("River content used when injected and planningMode active", () => {
    _injectRiverDocForTesting("planning-mode", "River planning instructions");
    setPlanningMode(true);
    const result = buildGeneral();
    expect(result).toContain("PLANNING MODE ACTIVE:");
    expect(result).toContain("River planning instructions");
  });

  test("section absent when River cache empty even if planningMode active (ELLIE-537)", () => {
    setPlanningMode(true);
    expect(buildGeneral()).not.toContain("PLANNING MODE ACTIVE:");
  });

  test("section omitted when planningMode is false", () => {
    _injectRiverDocForTesting("planning-mode", "Planning");
    expect(buildGeneral()).not.toContain("PLANNING MODE ACTIVE:");
  });

  test("section label in BuildMetrics when active", () => {
    _injectRiverDocForTesting("planning-mode", "Content");
    setPlanningMode(true);
    buildGeneral();
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "planning-mode")).toBeDefined();
  });

  test("absent from BuildMetrics when planning mode off", () => {
    _injectRiverDocForTesting("planning-mode", "Content");
    buildGeneral();
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "planning-mode")).toBeUndefined();
  });

  test("section_priority from frontmatter", () => {
    _injectRiverDocForTesting("planning-mode", "Body", { section_priority: 2 });
    setPlanningMode(true);
    buildGeneral();
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "planning-mode")?.priority).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// ALL-PROTOCOL INTEGRATION
// ════════════════════════════════════════════════════════════════════════════════

describe("integration — all River sources loaded simultaneously", () => {
  test("all protocol sections present for dev agent with all River docs", () => {
    _injectRiverDocForTesting("soul", "River soul — blocked for dev");
    _injectRiverDocForTesting("memory-protocol", "River memory");
    _injectRiverDocForTesting("confirm-protocol", "River confirm");
    _injectRiverDocForTesting("dev-agent-template", RIVER_DEV_TEMPLATE);
    _injectRiverDocForTesting("forest-writes", "Forest writes");
    _injectRiverDocForTesting("work-commands", "Work commands");

    const result = buildPrompt(
      "Fix the auth system", undefined, undefined, undefined, "ellie-chat",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
      undefined, undefined, undefined, undefined, undefined, SESSION_IDS,
    );

    // Soul blocked for dev
    expect(result).not.toContain("River soul — blocked for dev");
    // Protocols present
    expect(result).toContain("River memory");
    expect(result).toContain("River confirm");
    expect(result).toContain(RIVER_DEV_TEMPLATE);
    expect(result).toContain("Forest writes");
    expect(result).toContain("Work commands");
    // Headers
    expect(result).toContain("DEV AGENT PROTOCOL:");
    expect(result).toContain("MEMORY MANAGEMENT:");
    expect(result).toContain("ACTION CONFIRMATIONS:");
    expect(result).toContain("FOREST MEMORY WRITES (IMPORTANT):");
    expect(result).toContain("WORK ITEM COMMANDS:");
  });

  test("metrics include work-item section when workItemContext provided", () => {
    buildPrompt("Fix", undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM);
    const labels = getLastBuildMetrics()!.sections.map(s => s.label);
    expect(labels).toContain("work-item");
  });

  test("all protocol sections absent when cache empty (ELLIE-537)", () => {
    const result = buildPrompt(
      "Fix", undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
      undefined, undefined, undefined, undefined, undefined, SESSION_IDS,
    );
    expect(result).not.toContain("DEV AGENT PROTOCOL:");
    expect(result).not.toContain("MEMORY MANAGEMENT:");
    expect(result).not.toContain("ACTION CONFIRMATIONS:");
    expect(result).not.toContain("FOREST MEMORY WRITES (IMPORTANT):");
  });

  test("all four extracted protocol sections present with sessionIds and planningMode", () => {
    _injectRiverDocForTesting("forest-writes", "FW");
    _injectRiverDocForTesting("playbook-commands", "PB");
    _injectRiverDocForTesting("work-commands", "WC");
    _injectRiverDocForTesting("planning-mode", "PM");
    setPlanningMode(true);

    const result = buildWithSession();
    expect(result).toContain("FOREST MEMORY WRITES (IMPORTANT):");
    expect(result).toContain("WORK ITEM COMMANDS:");
    expect(result).toContain("PLANNING MODE ACTIVE:");
  });

  test("River-backed prompt has more sections than baseline", () => {
    // Baseline: no River docs
    buildPrompt("Fix", undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM);
    const baselineCount = getLastBuildMetrics()!.sectionCount;

    // River-backed: protocol sections now present
    _injectRiverDocForTesting("dev-agent-template", RIVER_DEV_TEMPLATE);
    _injectRiverDocForTesting("memory-protocol", "Memory");
    _injectRiverDocForTesting("confirm-protocol", "Confirm");
    buildPrompt("Fix", undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM);
    const riverCount = getLastBuildMetrics()!.sectionCount;

    expect(riverCount).toBeGreaterThan(baselineCount);
  });

  test("output format — protocol header present with River, absent without (ELLIE-537)", () => {
    _injectRiverDocForTesting("research-agent-template", "Research steps");
    const withRiver = buildPrompt("Research", undefined, undefined, undefined, "telegram", { name: "research" });
    expect(withRiver).toContain("RESEARCH AGENT PROTOCOL:");

    clearRiverDocCache();
    const withoutRiver = buildPrompt("Research", undefined, undefined, undefined, "telegram", { name: "research" });
    expect(withoutRiver).not.toContain("RESEARCH AGENT PROTOCOL:");
  });

  test("all research protocols injected: riverCacheMisses = 0", () => {
    _injectRiverDocForTesting("memory-protocol", "Memory");
    _injectRiverDocForTesting("confirm-protocol", "Confirm");
    _injectRiverDocForTesting("research-agent-template", "Research");
    _injectRiverDocForTesting("work-commands", "Work commands");
    buildPrompt("Research topic", undefined, undefined, undefined, "telegram", { name: "research" });
    expect(getLastBuildMetrics()!.riverCacheMisses).toBe(0);
  });

  test("all strategy protocols injected: riverCacheMisses = 0", () => {
    _injectRiverDocForTesting("memory-protocol", "Memory");
    _injectRiverDocForTesting("confirm-protocol", "Confirm");
    _injectRiverDocForTesting("strategy-agent-template", "Strategy");
    _injectRiverDocForTesting("work-commands", "Work commands");
    buildPrompt("Plan", undefined, undefined, undefined, "telegram", { name: "strategy" });
    expect(getLastBuildMetrics()!.riverCacheMisses).toBe(0);
  });
});
