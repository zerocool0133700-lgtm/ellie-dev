/**
 * ELLIE-535 — Remaining agents River-backed prompts
 *
 * Tests River-backed protocol sections for research and strategy agents:
 *   - research-protocol section: River template, hardcoded fallback, gating
 *   - strategy-protocol section: River template, hardcoded fallback, gating
 *   - Frontmatter section_priority applies to both protocols
 *   - ELLIE-525 soul gate: soul NOT injected for research/strategy agents
 *   - ELLIE-533/525 cross-check: dev-protocol NOT in research/strategy builds
 *   - BuildMetrics: protocol sections show up with correct labels
 *   - Cache hit/miss tracking for new keys
 *   - refreshRiverDocs resolves non-fatally with new keys registered
 *
 * No module mocking — uses _injectRiverDocForTesting() to control cache state.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  buildPrompt,
  getLastBuildMetrics,
  getCachedRiverDoc,
  clearRiverDocCache,
  setRiverDocCacheTtl,
  refreshRiverDocs,
  getRiverDocMetrics,
  _injectRiverDocForTesting,
  _resetRiverMetricsForTesting,
  stopPersonalityWatchers,
} from "../src/prompt-builder.ts";

// ── Cleanup ────────────────────────────────────────────────────────────────────

afterAll(() => {
  stopPersonalityWatchers();
  clearRiverDocCache();
  setRiverDocCacheTtl(60_000);
  _resetRiverMetricsForTesting();
});

// ── Helpers ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  clearRiverDocCache();
  setRiverDocCacheTtl(60_000);
  _resetRiverMetricsForTesting();
});

// ── RIVER_DOC_PATHS — new keys registered ──────────────────────────────────────

describe("RIVER_DOC_PATHS — research/strategy keys registered (ELLIE-535)", () => {
  test("'research-agent-template' key is registered (returns null on miss)", () => {
    expect(getCachedRiverDoc("research-agent-template")).toBeNull();
  });

  test("'strategy-agent-template' key is registered (returns null on miss)", () => {
    expect(getCachedRiverDoc("strategy-agent-template")).toBeNull();
  });

  test("inject research-agent-template and retrieve it", () => {
    _injectRiverDocForTesting("research-agent-template", "Research content");
    expect(getCachedRiverDoc("research-agent-template")).toBe("Research content");
  });

  test("inject strategy-agent-template and retrieve it", () => {
    _injectRiverDocForTesting("strategy-agent-template", "Strategy content");
    expect(getCachedRiverDoc("strategy-agent-template")).toBe("Strategy content");
  });
});

// ── buildPrompt — research-protocol section ───────────────────────────────────

describe("buildPrompt — research-protocol (ELLIE-535)", () => {
  test("uses River research template when injected", () => {
    _injectRiverDocForTesting("research-agent-template", "RIVER RESEARCH: gather, evaluate, synthesize");
    const result = buildPrompt("Research quantum computing", undefined, undefined, undefined, "telegram", {
      system_prompt: "You are a research agent.",
      name: "research",
    });
    expect(result).toContain("RIVER RESEARCH: gather, evaluate, synthesize");
    expect(result).toContain("RESEARCH AGENT PROTOCOL:");
  });

  test("hardcoded fallback used when River research template cache is empty", () => {
    const result = buildPrompt("Research this topic", undefined, undefined, undefined, "telegram", {
      system_prompt: "You are a research agent.",
      name: "research",
    });
    expect(result).toContain("RESEARCH AGENT PROTOCOL:");
    expect(result).toContain("Search the Forest for prior context");
  });

  test("hardcoded fallback contains key research steps", () => {
    const result = buildPrompt("Research topic", undefined, undefined, undefined, "telegram", {
      name: "research",
    });
    expect(result).toContain("RESEARCH AGENT PROTOCOL:");
    expect(result).toContain("QMD deep_search");
    expect(result).toContain("[MEMORY:]");
  });

  test("research-protocol section appears in build metrics", () => {
    buildPrompt("Research topic", undefined, undefined, undefined, "telegram", {
      name: "research",
    });
    const metrics = getLastBuildMetrics()!;
    const section = metrics.sections.find(s => s.label === "research-protocol");
    expect(section).toBeDefined();
  });

  test("research-protocol does NOT appear for general agent", () => {
    const result = buildPrompt("What is quantum computing?");
    expect(result).not.toContain("RESEARCH AGENT PROTOCOL:");
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label === "research-protocol")).toBeUndefined();
  });

  test("research-protocol does NOT appear for dev agent", () => {
    buildPrompt("Fix bug", undefined, undefined, undefined, "telegram", {
      name: "dev",
      system_prompt: "You are a dev agent.",
    });
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label === "research-protocol")).toBeUndefined();
  });

  test("research-protocol does NOT appear for strategy agent", () => {
    buildPrompt("Plan something", undefined, undefined, undefined, "telegram", {
      name: "strategy",
    });
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label === "research-protocol")).toBeUndefined();
  });

  test("research agent gets research-protocol without requiring active work item", () => {
    // Unlike dev-protocol, research-protocol always appears for research agent
    buildPrompt("Research topic", undefined, undefined, undefined, "telegram", {
      name: "research",
    });
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label === "research-protocol")).toBeDefined();
  });

  test("River research template overrides hardcoded — no fallback strings visible", () => {
    _injectRiverDocForTesting("research-agent-template", "Custom River research instructions");
    const result = buildPrompt("Research", undefined, undefined, undefined, "telegram", { name: "research" });
    expect(result).toContain("Custom River research instructions");
    // Hardcoded fallback strings should not appear when River template is loaded
    expect(result).not.toContain("Search the Forest for prior context: forest_read");
  });
});

// ── buildPrompt — strategy-protocol section ──────────────────────────────────

describe("buildPrompt — strategy-protocol (ELLIE-535)", () => {
  test("uses River strategy template when injected", () => {
    _injectRiverDocForTesting("strategy-agent-template", "RIVER STRATEGY: assess, plan, decide");
    const result = buildPrompt("Plan Q3 roadmap", undefined, undefined, undefined, "telegram", {
      system_prompt: "You are a strategy agent.",
      name: "strategy",
    });
    expect(result).toContain("RIVER STRATEGY: assess, plan, decide");
    expect(result).toContain("STRATEGY AGENT PROTOCOL:");
  });

  test("hardcoded fallback used when River strategy template cache is empty", () => {
    const result = buildPrompt("Plan the roadmap", undefined, undefined, undefined, "telegram", {
      system_prompt: "You are a strategy agent.",
      name: "strategy",
    });
    expect(result).toContain("STRATEGY AGENT PROTOCOL:");
    expect(result).toContain("Assess the current state");
  });

  test("hardcoded fallback contains key strategy steps", () => {
    const result = buildPrompt("Strategy question", undefined, undefined, undefined, "telegram", {
      name: "strategy",
    });
    expect(result).toContain("STRATEGY AGENT PROTOCOL:");
    expect(result).toContain("trade-offs");
    expect(result).toContain("[MEMORY:decision:]");
    expect(result).toContain("Propose but do not implement");
  });

  test("strategy-protocol section appears in build metrics", () => {
    buildPrompt("Plan something", undefined, undefined, undefined, "telegram", {
      name: "strategy",
    });
    const metrics = getLastBuildMetrics()!;
    const section = metrics.sections.find(s => s.label === "strategy-protocol");
    expect(section).toBeDefined();
  });

  test("strategy-protocol does NOT appear for general agent", () => {
    const result = buildPrompt("Hello");
    expect(result).not.toContain("STRATEGY AGENT PROTOCOL:");
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label === "strategy-protocol")).toBeUndefined();
  });

  test("strategy-protocol does NOT appear for dev agent", () => {
    buildPrompt("Fix bug", undefined, undefined, undefined, "telegram", {
      name: "dev",
    });
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label === "strategy-protocol")).toBeUndefined();
  });

  test("strategy-protocol does NOT appear for research agent", () => {
    buildPrompt("Research topic", undefined, undefined, undefined, "telegram", {
      name: "research",
    });
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label === "strategy-protocol")).toBeUndefined();
  });

  test("strategy agent gets strategy-protocol without requiring active work item", () => {
    buildPrompt("Plan something", undefined, undefined, undefined, "telegram", {
      name: "strategy",
    });
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label === "strategy-protocol")).toBeDefined();
  });

  test("River strategy template overrides hardcoded — no fallback strings visible", () => {
    _injectRiverDocForTesting("strategy-agent-template", "Custom River strategy instructions");
    const result = buildPrompt("Plan", undefined, undefined, undefined, "telegram", { name: "strategy" });
    expect(result).toContain("Custom River strategy instructions");
    expect(result).not.toContain("Propose but do not implement");
  });
});

// ── ELLIE-525 soul gate — research/strategy never get soul ───────────────────

describe("ELLIE-525 soul gate — research/strategy blocked", () => {
  test("soul NOT in research agent build even when River soul injected", () => {
    _injectRiverDocForTesting("soul", "RIVER SOUL SHOULD NOT APPEAR");
    const result = buildPrompt("Research topic", undefined, undefined, undefined, "telegram", {
      name: "research",
    });
    expect(result).not.toContain("RIVER SOUL SHOULD NOT APPEAR");
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label === "soul")).toBeUndefined();
  });

  test("soul NOT in strategy agent build even when River soul injected", () => {
    _injectRiverDocForTesting("soul", "RIVER SOUL SHOULD NOT APPEAR");
    const result = buildPrompt("Plan this", undefined, undefined, undefined, "telegram", {
      name: "strategy",
    });
    expect(result).not.toContain("RIVER SOUL SHOULD NOT APPEAR");
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label === "soul")).toBeUndefined();
  });
});

// ── ELLIE-533 cross-check: dev-protocol isolation ──────────────────────────────

describe("protocol isolation — each agent only gets its own protocol", () => {
  test("research agent does NOT get dev-protocol", () => {
    buildPrompt(
      "Research topic",
      undefined, undefined, undefined,
      "telegram",
      { name: "research" },
      "ACTIVE WORK ITEM: ELLIE-1 | Research task",
    );
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label === "dev-protocol")).toBeUndefined();
    expect(metrics.sections.find(s => s.label === "research-protocol")).toBeDefined();
  });

  test("strategy agent does NOT get dev-protocol", () => {
    buildPrompt(
      "Plan this",
      undefined, undefined, undefined,
      "telegram",
      { name: "strategy" },
      "ACTIVE WORK ITEM: ELLIE-1 | Plan task",
    );
    const metrics = getLastBuildMetrics()!;
    expect(metrics.sections.find(s => s.label === "dev-protocol")).toBeUndefined();
    expect(metrics.sections.find(s => s.label === "strategy-protocol")).toBeDefined();
  });

  test("dev agent does NOT get research-protocol or strategy-protocol", () => {
    buildPrompt(
      "Fix this",
      undefined, undefined, undefined,
      "telegram",
      { name: "dev" },
      "ACTIVE WORK ITEM: ELLIE-1 | Fix task",
    );
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

// ── Frontmatter section_priority ──────────────────────────────────────────────

describe("frontmatter section_priority — research/strategy (ELLIE-535)", () => {
  test("research-agent-template uses frontmatter section_priority when set", () => {
    _injectRiverDocForTesting("research-agent-template", "Research content", { section_priority: 4 });
    buildPrompt("Research topic", undefined, undefined, undefined, "telegram", { name: "research" });
    const metrics = getLastBuildMetrics()!;
    const section = metrics.sections.find(s => s.label === "research-protocol");
    expect(section).toBeDefined();
    expect(section!.priority).toBe(4);
  });

  test("strategy-agent-template uses frontmatter section_priority when set", () => {
    _injectRiverDocForTesting("strategy-agent-template", "Strategy content", { section_priority: 2 });
    buildPrompt("Plan this", undefined, undefined, undefined, "telegram", { name: "strategy" });
    const metrics = getLastBuildMetrics()!;
    const section = metrics.sections.find(s => s.label === "strategy-protocol");
    expect(section).toBeDefined();
    expect(section!.priority).toBe(2);
  });

  test("default priority 3 used for research-protocol when no frontmatter", () => {
    _injectRiverDocForTesting("research-agent-template", "Research content");
    buildPrompt("Research topic", undefined, undefined, undefined, "telegram", { name: "research" });
    const metrics = getLastBuildMetrics()!;
    const section = metrics.sections.find(s => s.label === "research-protocol");
    expect(section!.priority).toBe(3);
  });

  test("default priority 3 used for strategy-protocol when no frontmatter", () => {
    _injectRiverDocForTesting("strategy-agent-template", "Strategy content");
    buildPrompt("Plan this", undefined, undefined, undefined, "telegram", { name: "strategy" });
    const metrics = getLastBuildMetrics()!;
    const section = metrics.sections.find(s => s.label === "strategy-protocol");
    expect(section!.priority).toBe(3);
  });

  test("section_priority 8 suppresses research-protocol (>= threshold)", () => {
    _injectRiverDocForTesting("research-agent-template", "SUPPRESSED RESEARCH", { section_priority: 8 });
    const result = buildPrompt("Research topic", undefined, undefined, undefined, "telegram", { name: "research" });
    expect(result).not.toContain("SUPPRESSED RESEARCH");
  });

  test("section_priority 8 suppresses strategy-protocol (>= threshold)", () => {
    _injectRiverDocForTesting("strategy-agent-template", "SUPPRESSED STRATEGY", { section_priority: 8 });
    const result = buildPrompt("Plan this", undefined, undefined, undefined, "telegram", { name: "strategy" });
    expect(result).not.toContain("SUPPRESSED STRATEGY");
  });
});

// ── BuildMetrics — riverCacheHits/Misses for new protocols ───────────────────

describe("BuildMetrics — river cache tracking for research/strategy", () => {
  test("research protocol hit is counted in riverCacheHits", () => {
    _injectRiverDocForTesting("research-agent-template", "Research proto");
    buildPrompt("Research", undefined, undefined, undefined, "telegram", { name: "research" });
    const metrics = getLastBuildMetrics()!;
    expect(metrics.riverCacheHits).toBeGreaterThanOrEqual(1);
  });

  test("research protocol miss is counted in riverCacheMisses", () => {
    // No injection — cache is empty
    buildPrompt("Research", undefined, undefined, undefined, "telegram", { name: "research" });
    const metrics = getLastBuildMetrics()!;
    expect(metrics.riverCacheMisses).toBeGreaterThanOrEqual(1);
  });

  test("strategy protocol hit is counted in riverCacheHits", () => {
    _injectRiverDocForTesting("strategy-agent-template", "Strategy proto");
    buildPrompt("Plan", undefined, undefined, undefined, "telegram", { name: "strategy" });
    const metrics = getLastBuildMetrics()!;
    expect(metrics.riverCacheHits).toBeGreaterThanOrEqual(1);
  });

  test("strategy protocol miss is counted in riverCacheMisses", () => {
    buildPrompt("Plan", undefined, undefined, undefined, "telegram", { name: "strategy" });
    const metrics = getLastBuildMetrics()!;
    expect(metrics.riverCacheMisses).toBeGreaterThanOrEqual(1);
  });

  test("all research protocols injected: riverCacheMisses = 0 for all protocol lookups", () => {
    _injectRiverDocForTesting("memory-protocol", "Memory");
    _injectRiverDocForTesting("confirm-protocol", "Confirm");
    _injectRiverDocForTesting("research-agent-template", "Research");
    buildPrompt("Research topic", undefined, undefined, undefined, "telegram", { name: "research" });
    const metrics = getLastBuildMetrics()!;
    // Soul is NOT looked up for research (ELLIE-525), so no soul miss
    // memory, confirm, research all hit
    expect(metrics.riverCacheMisses).toBe(0);
  });
});

// ── refreshRiverDocs — 6 registered docs now ─────────────────────────────────

describe("refreshRiverDocs — 6 registered docs (ELLIE-535)", () => {
  test("resolves without throwing with 6 registered docs", async () => {
    await expect(refreshRiverDocs()).resolves.toBeUndefined();
  });

  test("lastRefresh.loaded + lastRefresh.failed <= 6 after refresh", async () => {
    await refreshRiverDocs();
    const { lastRefresh } = getRiverDocMetrics();
    const total = lastRefresh!.loaded + lastRefresh!.failed;
    expect(total).toBeGreaterThanOrEqual(0);
    expect(total).toBeLessThanOrEqual(6);
  });
});

// ── All-River integration — all 6 docs injected ───────────────────────────────

describe("integration — all River docs injected for research agent", () => {
  test("research build with all River docs: 0 cache misses", () => {
    _injectRiverDocForTesting("memory-protocol", "Memory proto");
    _injectRiverDocForTesting("confirm-protocol", "Confirm proto");
    _injectRiverDocForTesting("research-agent-template", "Research proto");
    // soul NOT injected — research agent doesn't look it up (ELLIE-525)
    buildPrompt("Research topic", undefined, undefined, undefined, "telegram", { name: "research" });
    const metrics = getLastBuildMetrics()!;
    expect(metrics.riverCacheMisses).toBe(0);
    expect(metrics.riverCacheHits).toBeGreaterThanOrEqual(3);
  });

  test("strategy build with all River docs: 0 cache misses", () => {
    _injectRiverDocForTesting("memory-protocol", "Memory proto");
    _injectRiverDocForTesting("confirm-protocol", "Confirm proto");
    _injectRiverDocForTesting("strategy-agent-template", "Strategy proto");
    buildPrompt("Plan this", undefined, undefined, undefined, "telegram", { name: "strategy" });
    const metrics = getLastBuildMetrics()!;
    expect(metrics.riverCacheMisses).toBe(0);
    expect(metrics.riverCacheHits).toBeGreaterThanOrEqual(3);
  });
});

// ── Output comparison: River vs hardcoded contain protocol label ──────────────

describe("output format consistency — protocol label always present", () => {
  test("research-protocol output always starts with RESEARCH AGENT PROTOCOL:", () => {
    // With River
    _injectRiverDocForTesting("research-agent-template", "River research content");
    const withRiver = buildPrompt("Research", undefined, undefined, undefined, "telegram", { name: "research" });
    expect(withRiver).toContain("RESEARCH AGENT PROTOCOL:");

    clearRiverDocCache();
    // Without River (hardcoded fallback)
    const withFallback = buildPrompt("Research", undefined, undefined, undefined, "telegram", { name: "research" });
    expect(withFallback).toContain("RESEARCH AGENT PROTOCOL:");
  });

  test("strategy-protocol output always starts with STRATEGY AGENT PROTOCOL:", () => {
    // With River
    _injectRiverDocForTesting("strategy-agent-template", "River strategy content");
    const withRiver = buildPrompt("Plan", undefined, undefined, undefined, "telegram", { name: "strategy" });
    expect(withRiver).toContain("STRATEGY AGENT PROTOCOL:");

    clearRiverDocCache();
    // Without River (hardcoded fallback)
    const withFallback = buildPrompt("Plan", undefined, undefined, undefined, "telegram", { name: "strategy" });
    expect(withFallback).toContain("STRATEGY AGENT PROTOCOL:");
  });
});
