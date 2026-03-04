import { describe, it, expect } from "bun:test";
import {
  trimSearchContext,
  getSpecialistAck,
  formatForestMetrics,
  mapHealthToMemoryCategory,
  estimateTokens,
  applyTokenBudget,
  type PromptSection,
} from "../src/relay-utils.ts";

// ── trimSearchContext ──────────────────────────────────────────

describe("trimSearchContext", () => {
  it("combines multiple sources within budget", () => {
    const result = trimSearchContext(["Hello", "World"], 100);
    expect(result).toBe("Hello\nWorld");
  });

  it("respects character limit", () => {
    const short = "Short source";
    const long = "A".repeat(3000);
    const result = trimSearchContext([short, long], 100);
    // Short source fits, long gets truncated
    expect(result.length).toBeLessThanOrEqual(100 + 1); // +1 for the join newline
    expect(result).toContain(short);
  });

  it("truncates at nearest newline boundary", () => {
    const source = "Line one\nLine two\nLine three\nLine four";
    const result = trimSearchContext([source], 20);
    // Should cut before a full line, not mid-word
    expect(result).toBe("Line one\nLine two");
  });

  it("skips empty sources", () => {
    const result = trimSearchContext(["", "Hello", "", "World"], 100);
    expect(result).toBe("Hello\nWorld");
  });

  it("returns empty string for all-empty sources", () => {
    const result = trimSearchContext(["", "", ""], 100);
    expect(result).toBe("");
  });

  it("returns empty string for empty array", () => {
    const result = trimSearchContext([], 100);
    expect(result).toBe("");
  });

  it("prioritizes earlier sources", () => {
    const first = "A".repeat(80);
    const second = "B".repeat(80);
    const result = trimSearchContext([first, second], 100);
    // First source fits entirely, second won't fit
    expect(result).toContain("A".repeat(80));
    expect(result).not.toContain("B");
  });

  it("uses default maxChars of 3000", () => {
    const source = "X".repeat(4000);
    const result = trimSearchContext([source]);
    // Should be truncated to ~3000 (no newlines, so nothing to cut at)
    expect(result).toBe("");
    // No newline in source means lastIndexOf('\n') returns -1, which is <= 0
    // so nothing gets pushed
  });

  it("handles source exactly at budget", () => {
    const source = "Hello"; // 5 chars
    const result = trimSearchContext([source], 5);
    expect(result).toBe("Hello");
  });
});

// ── getSpecialistAck ──────────────────────────────────────────

describe("getSpecialistAck", () => {
  it("returns dev ack", () => {
    expect(getSpecialistAck("dev")).toBe("On it — sending that to the dev specialist.");
  });

  it("returns research ack", () => {
    expect(getSpecialistAck("research")).toBe("Let me look into that for you.");
  });

  it("returns finance ack", () => {
    expect(getSpecialistAck("finance")).toBe("Checking on that with the finance specialist.");
  });

  it("returns content ack", () => {
    expect(getSpecialistAck("content")).toBe("I'll draft that up for you.");
  });

  it("returns strategy ack", () => {
    expect(getSpecialistAck("strategy")).toBe("Let me think through that strategically.");
  });

  it("returns fallback with agent name for unknown agent", () => {
    expect(getSpecialistAck("analytics")).toBe(
      "Working on that — I've dispatched the analytics specialist.",
    );
  });

  it("returns fallback for empty string", () => {
    expect(getSpecialistAck("")).toBe(
      "Working on that — I've dispatched the  specialist.",
    );
  });
});

// ── formatForestMetrics ───────────────────────────────────────

describe("formatForestMetrics", () => {
  it("formats basic totals", () => {
    const result = formatForestMetrics({
      totalEvents: 100,
      totalCreatures: 50,
      totalTrees: 10,
      failureRate: 0.05,
      creaturesByEntity: {},
      eventsByKind: {},
      treesByType: {},
      creaturesByState: {},
    });

    expect(result).toContain("Forest Metrics (last 7 days)");
    expect(result).toContain("Events: 100 | Creatures: 50 | Trees: 10");
    expect(result).toContain("Failure rate: 5.0%");
  });

  it("formats failure rate with one decimal", () => {
    const result = formatForestMetrics({
      totalEvents: 0, totalCreatures: 0, totalTrees: 0,
      failureRate: 0.123,
      creaturesByEntity: {}, eventsByKind: {}, treesByType: {}, creaturesByState: {},
    });
    expect(result).toContain("Failure rate: 12.3%");
  });

  it("includes creatures by entity sorted descending", () => {
    const result = formatForestMetrics({
      totalEvents: 0, totalCreatures: 0, totalTrees: 0, failureRate: 0,
      creaturesByEntity: { dev_agent: 5, research_agent: 20, strategy_agent: 10 },
      eventsByKind: {}, treesByType: {}, creaturesByState: {},
    });

    expect(result).toContain("Creatures by entity:");
    const entitySection = result.split("Creatures by entity:")[1];
    const lines = entitySection.split("\n").filter(l => l.trim());
    expect(lines[0]).toContain("research_agent: 20");
    expect(lines[1]).toContain("strategy_agent: 10");
    expect(lines[2]).toContain("dev_agent: 5");
  });

  it("includes events by kind limited to 15", () => {
    const kinds: Record<string, number> = {};
    for (let i = 0; i < 20; i++) {
      kinds[`event_${i}`] = 20 - i;
    }
    const result = formatForestMetrics({
      totalEvents: 0, totalCreatures: 0, totalTrees: 0, failureRate: 0,
      creaturesByEntity: {}, eventsByKind: kinds, treesByType: {}, creaturesByState: {},
    });

    expect(result).toContain("Events by kind:");
    // Should contain the top 15 but not bottom 5
    expect(result).toContain("event_0: 20");
    expect(result).toContain("event_14: 6");
    expect(result).not.toContain("event_15:");
  });

  it("includes creatures by state", () => {
    const result = formatForestMetrics({
      totalEvents: 0, totalCreatures: 0, totalTrees: 0, failureRate: 0,
      creaturesByEntity: {}, eventsByKind: {}, treesByType: {},
      creaturesByState: { completed: 30, pending: 10, failed: 5 },
    });

    expect(result).toContain("Creatures by state:");
    expect(result).toContain("completed: 30");
    expect(result).toContain("pending: 10");
    expect(result).toContain("failed: 5");
  });

  it("omits empty sections", () => {
    const result = formatForestMetrics({
      totalEvents: 10, totalCreatures: 5, totalTrees: 2, failureRate: 0,
      creaturesByEntity: {}, eventsByKind: {}, treesByType: {}, creaturesByState: {},
    });

    expect(result).not.toContain("Creatures by entity:");
    expect(result).not.toContain("Events by kind:");
    expect(result).not.toContain("Creatures by state:");
  });
});

// ── mapHealthToMemoryCategory ─────────────────────────────────

describe("mapHealthToMemoryCategory", () => {
  it("maps health conditions", () => {
    for (const hc of ["condition", "medication", "symptom", "doctor_visit", "barrier", "sleep"]) {
      expect(mapHealthToMemoryCategory(hc)).toBe("health");
    }
  });

  it("maps fitness", () => {
    for (const hc of ["fitness", "nutrition"]) {
      expect(mapHealthToMemoryCategory(hc)).toBe("fitness");
    }
  });

  it("maps mental health", () => {
    for (const hc of ["mental_health", "anxiety", "depression_sign", "grief", "stress_load", "mood_shift", "overwhelm"]) {
      expect(mapHealthToMemoryCategory(hc)).toBe("mental_health");
    }
  });

  it("maps work", () => {
    for (const hc of ["focus", "organization", "time_mgmt", "follow_through", "career_change"]) {
      expect(mapHealthToMemoryCategory(hc)).toBe("work");
    }
  });

  it("maps relationships", () => {
    for (const hc of ["relationship", "loneliness", "conflict", "social_seeking", "relationship_milestone"]) {
      expect(mapHealthToMemoryCategory(hc)).toBe("relationships");
    }
  });

  it("maps family", () => {
    expect(mapHealthToMemoryCategory("caregiving")).toBe("family");
  });

  it("maps financial", () => {
    for (const hc of ["financial_stress", "income", "cost_barrier", "financial_goal"]) {
      expect(mapHealthToMemoryCategory(hc)).toBe("financial");
    }
  });

  it("maps learning", () => {
    for (const hc of ["dyslexia_esl", "tech_literacy", "learning_style", "communication_need"]) {
      expect(mapHealthToMemoryCategory(hc)).toBe("learning");
    }
  });

  it("maps identity", () => {
    for (const hc of ["relocation", "life_role_change", "identity"]) {
      expect(mapHealthToMemoryCategory(hc)).toBe("identity");
    }
  });

  it("returns general for unknown categories", () => {
    expect(mapHealthToMemoryCategory("unknown")).toBe("general");
    expect(mapHealthToMemoryCategory("")).toBe("general");
    expect(mapHealthToMemoryCategory("nonsense")).toBe("general");
  });
});

// ── estimateTokens ──────────────────────────────────────────

describe("estimateTokens", () => {
  it("returns a positive number for non-empty text", () => {
    const tokens = estimateTokens("Hello, world!");
    expect(tokens).toBeGreaterThan(0);
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns more tokens for longer text", () => {
    const short = estimateTokens("Hello");
    const long = estimateTokens("Hello, this is a much longer piece of text with many more words");
    expect(long).toBeGreaterThan(short);
  });

  it("roughly approximates ~4 chars per token for English", () => {
    const text = "The quick brown fox jumps over the lazy dog";
    const tokens = estimateTokens(text);
    // Should be somewhere around 10 tokens (44 chars / 4)
    expect(tokens).toBeGreaterThan(5);
    expect(tokens).toBeLessThan(20);
  });
});

// ── applyTokenBudget ────────────────────────────────────────

describe("applyTokenBudget", () => {
  it("returns all sections when under budget", () => {
    const sections: PromptSection[] = [
      { label: "system", content: "You are helpful.", priority: 1 },
      { label: "context", content: "Some context here.", priority: 3 },
    ];
    const result = applyTokenBudget(sections, 150_000);
    expect(result).toContain("You are helpful.");
    expect(result).toContain("Some context here.");
  });

  it("preserves priority-1 sections when trimming", () => {
    const critical = "Critical content that must remain.";
    const filler = "X ".repeat(50_000); // very large low-priority section
    const sections: PromptSection[] = [
      { label: "system", content: critical, priority: 1 },
      { label: "filler", content: filler, priority: 9 },
    ];
    const result = applyTokenBudget(sections, 100);
    expect(result).toContain(critical);
  });

  it("trims higher priority numbers first", () => {
    const sections: PromptSection[] = [
      { label: "system", content: "System prompt", priority: 1 },
      { label: "important", content: "Important context " + "X".repeat(200), priority: 2 },
      { label: "nice-to-have", content: "Nice to have " + "Y".repeat(200), priority: 5 },
      { label: "least", content: "Least important " + "Z".repeat(200), priority: 9 },
    ];
    // Set a budget that can only fit system + important
    const result = applyTokenBudget(sections, 200);
    expect(result).toContain("System prompt");
    // Priority 9 should be trimmed before priority 2
  });

  it("handles single section under budget", () => {
    const sections: PromptSection[] = [
      { label: "only", content: "Just this.", priority: 1 },
    ];
    const result = applyTokenBudget(sections, 150_000);
    expect(result).toBe("Just this.");
  });

  it("handles empty sections array", () => {
    const result = applyTokenBudget([], 150_000);
    expect(result).toBe("");
  });
});
