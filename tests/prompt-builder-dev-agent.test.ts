/**
 * ELLIE-533 — Dev agent River-backed prompt pipeline tests
 *
 * Validates the full QMD → prompt assembly pipeline for the dev agent:
 *
 *   1. River-backed dev-agent-template used when cached
 *   2. Hardcoded fallback when River is empty (QMD down scenario)
 *   3. Soul gate — dev agent NEVER receives soul section (ELLIE-525)
 *   4. Protocols (memory, confirm) from River when cached
 *   5. Protocol fallbacks for dev agent
 *   6. Frontmatter section_priority honoured for dev-agent-template
 *   7. Build metrics: section count, budget, token estimate
 *   8. Prompt output comparison — River vs hardcoded contain same key strings
 *   9. Cache hit/miss / clear cycle
 *  10. refreshRiverDocs resolves non-fatally in dev agent context
 *  11. Dev protocol absent when no work item context
 *  12. Dev protocol absent for general agent even with work item
 *  13. Channel-specific labels present (ellie-chat, telegram)
 *
 * No module mocking — uses _injectRiverDocForTesting() + clearRiverDocCache().
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  buildPrompt,
  getLastBuildMetrics,
  clearRiverDocCache,
  getCachedRiverDoc,
  setRiverDocCacheTtl,
  refreshRiverDocs,
  _injectRiverDocForTesting,
  stopPersonalityWatchers,
} from "../src/prompt-builder.ts";

// ── Constants matching vault content ──────────────────────────────────────────

const RIVER_DEV_TEMPLATE_CONTENT =
  "1. Read the ticket and understand requirements\n" +
  "2. Implement code changes\n" +
  "3. Commit with [ELLIE-N] prefix (e.g., [ELLIE-5] Brief description)\n" +
  "4. Build if dashboard code changed: cd /home/ellie/ellie-home && bun run build\n" +
  "5. Restart affected service: sudo systemctl restart ellie-dashboard\n" +
  "6. Verify changes work\n\n" +
  "Do NOT call /api/work-session/complete — handled externally.";

const DEV_AGENT_CONFIG = {
  system_prompt: "You are a dev specialist.",
  name: "dev",
};

const ACTIVE_WORK_ITEM = "ACTIVE WORK ITEM: ELLIE-533 — River-backed dev agent tests";

// ── Lifecycle ─────────────────────────────────────────────────────────────────

afterAll(() => {
  stopPersonalityWatchers();
  clearRiverDocCache();
  setRiverDocCacheTtl(60_000);
});

beforeEach(() => {
  clearRiverDocCache();
  setRiverDocCacheTtl(60_000);
});

// ── 1. River-backed dev-agent-template ───────────────────────────────────────

describe("dev agent — River-backed dev-agent-template", () => {
  test("River template content appears in prompt when cached", () => {
    _injectRiverDocForTesting("dev-agent-template", RIVER_DEV_TEMPLATE_CONTENT);
    const result = buildPrompt(
      "Fix the bug",
      undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG,
      ACTIVE_WORK_ITEM,
    );
    expect(result).toContain("DEV AGENT PROTOCOL:");
    expect(result).toContain(RIVER_DEV_TEMPLATE_CONTENT);
  });

  test("River template replaces hardcoded protocol entirely", () => {
    const riverContent = "CUSTOM RIVER DEV STEPS: step-a, step-b, step-c";
    _injectRiverDocForTesting("dev-agent-template", riverContent);
    const result = buildPrompt(
      "Fix it", undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
    );
    expect(result).toContain("CUSTOM RIVER DEV STEPS");
    // Hardcoded steps are gone
    expect(result).not.toContain("sudo systemctl restart ellie-dashboard");
  });

  test("dev-protocol section present in metrics when River template loaded", () => {
    _injectRiverDocForTesting("dev-agent-template", RIVER_DEV_TEMPLATE_CONTENT);
    buildPrompt(
      "Implement feature", undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
    );
    const metrics = getLastBuildMetrics()!;
    const devProtocol = metrics.sections.find(s => s.label === "dev-protocol");
    expect(devProtocol).toBeDefined();
  });

  test("getCachedRiverDoc('dev-agent-template') returns injected content", () => {
    _injectRiverDocForTesting("dev-agent-template", RIVER_DEV_TEMPLATE_CONTENT);
    expect(getCachedRiverDoc("dev-agent-template")).toBe(RIVER_DEV_TEMPLATE_CONTENT);
  });
});

// ── 2. River absent — section omitted (ELLIE-537: no hardcoded fallback) ─────

describe("dev agent — section absent when River empty (ELLIE-537)", () => {
  test("DEV AGENT PROTOCOL absent when cache empty", () => {
    const result = buildPrompt(
      "Fix the bug", undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
    );
    expect(result).not.toContain("DEV AGENT PROTOCOL:");
  });

  test("getCachedRiverDoc('dev-agent-template') returns null when cache empty", () => {
    expect(getCachedRiverDoc("dev-agent-template")).toBeNull();
  });
});

// ── 3. Soul gate (ELLIE-525) ─────────────────────────────────────────────────

describe("dev agent — soul gate (ELLIE-525)", () => {
  test("dev agent does NOT receive soul section even when River soul is cached", () => {
    _injectRiverDocForTesting("soul", "RIVER SOUL: patient teacher text");
    const result = buildPrompt(
      "Fix the bug", undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
    );
    expect(result).not.toContain("RIVER SOUL: patient teacher text");
  });

  test("dev agent metrics have no soul section", () => {
    _injectRiverDocForTesting("soul", "Soul content for dev gate test");
    buildPrompt(
      "Fix the bug", undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
    );
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label === "soul")).toBeUndefined();
  });

  test("research agent does NOT receive soul section", () => {
    _injectRiverDocForTesting("soul", "RIVER SOUL BLOCKED FOR RESEARCH");
    buildPrompt(
      "Research topic", undefined, undefined, undefined, "telegram",
      { system_prompt: "You are research.", name: "research" },
    );
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "soul")).toBeUndefined();
  });

  test("strategy agent does NOT receive soul section", () => {
    _injectRiverDocForTesting("soul", "RIVER SOUL BLOCKED FOR STRATEGY");
    buildPrompt(
      "Plan Q2", undefined, undefined, undefined, "telegram",
      { system_prompt: "You are strategy.", name: "strategy" },
    );
    expect(getLastBuildMetrics()!.sections.find(s => s.label === "soul")).toBeUndefined();
  });
});

// ── 4. River protocol docs in dev agent context ───────────────────────────────

describe("dev agent — River protocol docs", () => {
  test("River memory-protocol content appears in dev agent prompt", () => {
    _injectRiverDocForTesting("memory-protocol", "RIVER MEMORY: dev protocol override");
    const result = buildPrompt(
      "Fix bug", undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
    );
    expect(result).toContain("RIVER MEMORY: dev protocol override");
    expect(result).toContain("MEMORY MANAGEMENT:");
  });

  test("River confirm-protocol content appears in dev agent prompt", () => {
    _injectRiverDocForTesting("confirm-protocol", "RIVER CONFIRM: dev confirm override");
    const result = buildPrompt(
      "Fix bug", undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
    );
    expect(result).toContain("RIVER CONFIRM: dev confirm override");
    expect(result).toContain("ACTION CONFIRMATIONS:");
  });

  test("memory-protocol section absent in dev agent when River cache empty (ELLIE-537)", () => {
    const result = buildPrompt(
      "Fix bug", undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
    );
    expect(result).not.toContain("MEMORY MANAGEMENT:");
  });

  test("confirm-protocol section absent in dev agent when River cache empty (ELLIE-537)", () => {
    const result = buildPrompt(
      "Fix bug", undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
    );
    expect(result).not.toContain("ACTION CONFIRMATIONS:");
  });
});

// ── 5. Frontmatter section_priority for dev-agent-template ───────────────────

describe("dev agent — frontmatter section_priority", () => {
  test("dev-protocol uses frontmatter section_priority: 4 from River doc", () => {
    _injectRiverDocForTesting("dev-agent-template", "Steps here", { section_priority: 4 });
    buildPrompt(
      "Fix bug", undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
    );
    const metrics = getLastBuildMetrics()!;
    const devProto = metrics.sections.find(s => s.label === "dev-protocol");
    expect(devProto).toBeDefined();
    expect(devProto!.priority).toBe(4);
  });

  test("dev-protocol defaults to priority 3 when no frontmatter section_priority", () => {
    _injectRiverDocForTesting("dev-agent-template", "Steps here"); // no frontmatter
    buildPrompt(
      "Fix bug", undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
    );
    const metrics = getLastBuildMetrics()!;
    const devProto = metrics.sections.find(s => s.label === "dev-protocol");
    expect(devProto!.priority).toBe(3);
  });

  test("section_priority: 8 suppresses dev-protocol section", () => {
    _injectRiverDocForTesting("dev-agent-template", "SUPPRESSED DEV STEPS", { section_priority: 8 });
    const result = buildPrompt(
      "Fix bug", undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
    );
    expect(result).not.toContain("SUPPRESSED DEV STEPS");
  });
});

// ── 6. Build metrics — dev agent ──────────────────────────────────────────────

describe("dev agent — build metrics", () => {
  test("metrics not null after buildPrompt", () => {
    buildPrompt("Fix bug", undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM);
    expect(getLastBuildMetrics()).not.toBeNull();
  });

  test("metrics include dev-protocol section", () => {
    _injectRiverDocForTesting("dev-agent-template", "River dev steps");
    buildPrompt("Fix bug", undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM);
    const labels = getLastBuildMetrics()!.sections.map(s => s.label);
    expect(labels).toContain("dev-protocol");
  });

  test("metrics include work-item section", () => {
    buildPrompt("Fix bug", undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM);
    const labels = getLastBuildMetrics()!.sections.map(s => s.label);
    expect(labels).toContain("work-item");
  });

  test("metrics include base-prompt section", () => {
    buildPrompt("Fix bug", undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM);
    const labels = getLastBuildMetrics()!.sections.map(s => s.label);
    expect(labels).toContain("base-prompt");
  });

  test("metrics do NOT include soul section for dev agent", () => {
    buildPrompt("Fix bug", undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM);
    const labels = getLastBuildMetrics()!.sections.map(s => s.label);
    expect(labels).not.toContain("soul");
  });

  test("totalTokens > 0 for dev agent prompt", () => {
    buildPrompt("Fix bug", undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM);
    expect(getLastBuildMetrics()!.totalTokens).toBeGreaterThan(0);
  });

  test("creature name is 'dev' in metrics", () => {
    buildPrompt("Fix bug", undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM);
    expect(getLastBuildMetrics()!.creature).toBe("dev");
  });

  test("sectionCount matches sections array length", () => {
    buildPrompt("Fix bug", undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM);
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sectionCount).toBe(metrics.sections.length);
  });

  test("River-backed prompt has more sections than baseline (River adds protocol sections)", () => {
    // Baseline: no River docs — protocol sections omitted
    buildPrompt("Fix bug", undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM);
    const baselineCount = getLastBuildMetrics()!.sectionCount;

    // River-backed: protocol sections now present
    _injectRiverDocForTesting("dev-agent-template", RIVER_DEV_TEMPLATE_CONTENT);
    _injectRiverDocForTesting("memory-protocol", "River memory content");
    _injectRiverDocForTesting("confirm-protocol", "River confirm content");
    buildPrompt("Fix bug", undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM);
    const riverCount = getLastBuildMetrics()!.sectionCount;

    // River adds sections that were absent without it
    expect(riverCount).toBeGreaterThan(baselineCount);
  });
});

// ── 7. Prompt output comparison — River vs hardcoded ─────────────────────────

describe("dev agent — prompt output comparison: River vs hardcoded", () => {
  test("River-backed prompt contains 'DEV AGENT PROTOCOL:' (same as hardcoded)", () => {
    _injectRiverDocForTesting("dev-agent-template", RIVER_DEV_TEMPLATE_CONTENT);
    const result = buildPrompt(
      "Fix bug", undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
    );
    expect(result).toContain("DEV AGENT PROTOCOL:");
  });

  test("River-backed prompt contains '[ELLIE-N] prefix' (same as hardcoded)", () => {
    _injectRiverDocForTesting("dev-agent-template", RIVER_DEV_TEMPLATE_CONTENT);
    const result = buildPrompt(
      "Fix bug", undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
    );
    expect(result).toContain("[ELLIE-N] prefix");
  });

  test("River-backed prompt contains MEMORY MANAGEMENT when memory-protocol injected", () => {
    _injectRiverDocForTesting("memory-protocol", "River memory content");
    const river = buildPrompt(
      "Fix bug", undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
    );
    expect(river).toContain("MEMORY MANAGEMENT:");
  });

  test("River-backed prompt contains ACTION CONFIRMATIONS when confirm-protocol injected", () => {
    _injectRiverDocForTesting("confirm-protocol", "River confirm content");
    const river = buildPrompt(
      "Fix bug", undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
    );
    expect(river).toContain("ACTION CONFIRMATIONS:");
  });

  test("River-backed and hardcoded prompts both include the user message", () => {
    const msg = "Fix the authentication bug in relay.ts";

    const hardcoded = buildPrompt(msg, undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM);
    expect(hardcoded).toContain(msg);

    _injectRiverDocForTesting("dev-agent-template", RIVER_DEV_TEMPLATE_CONTENT);
    const river = buildPrompt(msg, undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM);
    expect(river).toContain(msg);
  });

  test("River-backed and hardcoded prompts both include custom system prompt", () => {
    const hardcoded = buildPrompt("Fix bug", undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM);
    expect(hardcoded).toContain("You are a dev specialist.");

    _injectRiverDocForTesting("dev-agent-template", RIVER_DEV_TEMPLATE_CONTENT);
    const river = buildPrompt("Fix bug", undefined, undefined, undefined, "telegram", DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM);
    expect(river).toContain("You are a dev specialist.");
  });
});

// ── 8. Cache hit/miss/clear cycle ────────────────────────────────────────────

describe("dev agent — cache hit/miss/clear cycle", () => {
  test("miss → inject → hit → clear → miss", () => {
    // Miss
    expect(getCachedRiverDoc("dev-agent-template")).toBeNull();

    // Inject → hit
    _injectRiverDocForTesting("dev-agent-template", "content-A");
    expect(getCachedRiverDoc("dev-agent-template")).toBe("content-A");

    // Clear → miss
    clearRiverDocCache();
    expect(getCachedRiverDoc("dev-agent-template")).toBeNull();
  });

  test("stale-while-revalidate: stale content returned after TTL=0", () => {
    setRiverDocCacheTtl(0);
    _injectRiverDocForTesting("dev-agent-template", "stale-template");
    // Still returned even though TTL=0 (stale-while-revalidate)
    expect(getCachedRiverDoc("dev-agent-template")).toBe("stale-template");
  });

  test("clearRiverDocCache removes all keys including dev-agent-template", () => {
    _injectRiverDocForTesting("dev-agent-template", "template");
    _injectRiverDocForTesting("soul", "soul-content");
    _injectRiverDocForTesting("memory-protocol", "memory");
    clearRiverDocCache();
    expect(getCachedRiverDoc("dev-agent-template")).toBeNull();
    expect(getCachedRiverDoc("soul")).toBeNull();
    expect(getCachedRiverDoc("memory-protocol")).toBeNull();
  });
});

// ── 9. refreshRiverDocs — dev agent context ───────────────────────────────────

describe("dev agent — refreshRiverDocs", () => {
  test("resolves without throwing", async () => {
    await expect(refreshRiverDocs()).resolves.toBeUndefined();
  });

  test("subsequent call after cache clear resolves without throwing", async () => {
    clearRiverDocCache();
    await expect(refreshRiverDocs()).resolves.toBeUndefined();
  });
});

// ── 10. Dev protocol absent when no work item ─────────────────────────────────

describe("dev agent — dev protocol conditional on work item", () => {
  test("dev-protocol absent when no workItemContext", () => {
    _injectRiverDocForTesting("dev-agent-template", RIVER_DEV_TEMPLATE_CONTENT);
    buildPrompt(
      "Just a dev question", undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG,
      // no workItemContext
    );
    const labels = getLastBuildMetrics()!.sections.map(s => s.label);
    expect(labels).not.toContain("dev-protocol");
  });

  test("dev-protocol absent when workItemContext doesn't contain 'ACTIVE WORK ITEM'", () => {
    _injectRiverDocForTesting("dev-agent-template", RIVER_DEV_TEMPLATE_CONTENT);
    buildPrompt(
      "Fix bug", undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG,
      "Some other context without the trigger phrase",
    );
    const labels = getLastBuildMetrics()!.sections.map(s => s.label);
    expect(labels).not.toContain("dev-protocol");
  });

  test("dev-protocol absent for general agent even with work item", () => {
    _injectRiverDocForTesting("dev-agent-template", RIVER_DEV_TEMPLATE_CONTENT);
    buildPrompt(
      "Hello", undefined, undefined, undefined, "telegram",
      { name: "general" },
      ACTIVE_WORK_ITEM,
    );
    const labels = getLastBuildMetrics()!.sections.map(s => s.label);
    expect(labels).not.toContain("dev-protocol");
  });
});

// ── 11. Channel labels in dev agent prompts ────────────────────────────────────

describe("dev agent — channel labels", () => {
  test("ellie-chat channel label appears in dev agent prompt", () => {
    const result = buildPrompt(
      "Fix bug", undefined, undefined, undefined, "ellie-chat",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
    );
    expect(result).toContain("Ellie Chat (dashboard)");
  });

  test("telegram channel label appears in dev agent prompt", () => {
    const result = buildPrompt(
      "Fix bug", undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
    );
    expect(result).toContain("Telegram");
  });
});

// ── 12. All River sources loaded simultaneously ───────────────────────────────

describe("dev agent — all River sources loaded simultaneously", () => {
  test("all three River docs in cache — prompt assembly succeeds", () => {
    _injectRiverDocForTesting("soul", "River soul — blocked for dev");
    _injectRiverDocForTesting("memory-protocol", "River memory protocol for dev");
    _injectRiverDocForTesting("confirm-protocol", "River confirm protocol for dev");
    _injectRiverDocForTesting("dev-agent-template", RIVER_DEV_TEMPLATE_CONTENT);

    const result = buildPrompt(
      "Fix the authentication system", undefined, undefined, undefined, "ellie-chat",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
    );

    // Soul blocked
    expect(result).not.toContain("River soul — blocked for dev");
    // Protocols present
    expect(result).toContain("River memory protocol for dev");
    expect(result).toContain("River confirm protocol for dev");
    // Dev template present
    expect(result).toContain(RIVER_DEV_TEMPLATE_CONTENT);
    // Required structure
    expect(result).toContain("DEV AGENT PROTOCOL:");
    expect(result).toContain("MEMORY MANAGEMENT:");
    expect(result).toContain("ACTION CONFIRMATIONS:");
    expect(result).toContain("Fix the authentication system");
  });

  test("all River docs absent — protocol sections omitted (ELLIE-537: no hardcoded fallback)", () => {
    // Cache empty — all protocol sections omitted
    const result = buildPrompt(
      "Fix the auth bug", undefined, undefined, undefined, "telegram",
      DEV_AGENT_CONFIG, ACTIVE_WORK_ITEM,
    );
    expect(result).not.toContain("DEV AGENT PROTOCOL:");
    expect(result).not.toContain("MEMORY MANAGEMENT:");
    expect(result).not.toContain("ACTION CONFIRMATIONS:");
  });
});
