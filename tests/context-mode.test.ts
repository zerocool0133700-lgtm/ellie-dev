/**
 * ELLIE-559 — context-mode.ts tests
 *
 * Tests mode detection, context refresh detection, and mode config management.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  detectMode,
  isContextRefresh,
  getConversationMode,
  setConversationMode,
  clearConversationMode,
  getModeConfig,
  updateModeConfig,
  resetModeConfig,
  getModeSectionPriorities,
  getModeTokenBudget,
  processMessageMode,
  type ContextMode,
} from "../src/context-mode.ts";

// ── Reset state before each test ─────────────────────────────

beforeEach(() => {
  resetModeConfig();
  clearConversationMode("test-conv");
});

// ── detectMode — deep-work signals ──────────────────────────

describe("detectMode — deep-work", () => {
  test("'work on ELLIE-100' → deep-work with workItemId", () => {
    const r = detectMode("work on ELLIE-100");
    expect(r).not.toBeNull();
    expect(r!.mode).toBe("deep-work");
    expect(r!.workItemId).toBe("ELLIE-100");
  });

  test("'implement ELLIE-42' → deep-work", () => {
    expect(detectMode("implement ELLIE-42")!.mode).toBe("deep-work");
  });

  test("'fix ELLIE-300' → deep-work", () => {
    expect(detectMode("fix ELLIE-300")!.mode).toBe("deep-work");
  });

  test("'please work 559' → deep-work", () => {
    const r = detectMode("please work 559");
    expect(r!.mode).toBe("deep-work");
  });

  test("'ELLIE-5 implement the feature' → deep-work", () => {
    expect(detectMode("ELLIE-5 implement the feature")!.mode).toBe("deep-work");
  });

  test("'let's build something' → deep-work (medium confidence)", () => {
    const r = detectMode("let's build something");
    expect(r!.mode).toBe("deep-work");
    expect(r!.confidence).toBe("medium");
  });
});

// ── detectMode — strategy signals ───────────────────────────

describe("detectMode — strategy", () => {
  test("'brain dump' → strategy", () => {
    expect(detectMode("brain dump")!.mode).toBe("strategy");
  });

  test("'let's plan' → strategy", () => {
    expect(detectMode("let's plan the roadmap")!.mode).toBe("strategy");
  });

  test("'strategy for Q3' → strategy", () => {
    expect(detectMode("strategy for Q3")!.mode).toBe("strategy");
  });

  test("'what should we do about...' → strategy", () => {
    expect(detectMode("what should we do about the architecture")!.mode).toBe("strategy");
  });

  test("'I've been thinking about' → strategy (medium)", () => {
    const r = detectMode("I've been thinking about redesigning this");
    expect(r!.mode).toBe("strategy");
  });
});

// ── detectMode — skill-only signals ─────────────────────────

describe("detectMode — skill-only", () => {
  test("slash commands → skill-only", () => {
    expect(detectMode("/briefing")!.mode).toBe("skill-only");
  });

  test("'check the weather' → skill-only", () => {
    expect(detectMode("check the weather")!.mode).toBe("skill-only");
  });

  test("'what's on my calendar' → skill-only", () => {
    expect(detectMode("what's on my calendar")!.mode).toBe("skill-only");
  });

  test("'triage ELLIE-100' → skill-only with workItemId", () => {
    const r = detectMode("triage ELLIE-100");
    expect(r!.mode).toBe("skill-only");
    expect(r!.workItemId).toBe("ELLIE-100");
  });

  test("'just dispatch this' → skill-only", () => {
    expect(detectMode("just dispatch this")!.mode).toBe("skill-only");
  });
});

// ── detectMode — workflow signals ───────────────────────────

describe("detectMode — workflow", () => {
  test("'dispatch the task' → workflow", () => {
    expect(detectMode("dispatch the task")!.mode).toBe("workflow");
  });

  test("'what's running' → workflow", () => {
    expect(detectMode("what's running")!.mode).toBe("workflow");
  });

  test("'queue status' → workflow", () => {
    expect(detectMode("queue status")!.mode).toBe("workflow");
  });
});

// ── detectMode — conversation signals ───────────────────────

describe("detectMode — conversation", () => {
  test("'hey' → conversation", () => {
    expect(detectMode("hey")!.mode).toBe("conversation");
  });

  test("'good morning' → conversation", () => {
    expect(detectMode("good morning")!.mode).toBe("conversation");
  });

  test("'how are you' → conversation", () => {
    expect(detectMode("how are you")!.mode).toBe("conversation");
  });
});

// ── detectMode — manual overrides ───────────────────────────

describe("detectMode — manual overrides", () => {
  test("'strategy mode' → strategy", () => {
    expect(detectMode("strategy mode")!.mode).toBe("strategy");
    expect(detectMode("strategy mode")!.confidence).toBe("high");
  });

  test("'deep work' → deep-work", () => {
    expect(detectMode("deep work")!.mode).toBe("deep-work");
  });

  test("'focus mode' → deep-work", () => {
    expect(detectMode("focus mode")!.mode).toBe("deep-work");
  });

  test("'conversation mode' → conversation", () => {
    expect(detectMode("conversation mode")!.mode).toBe("conversation");
  });

  test("'triage mode' → skill-only", () => {
    expect(detectMode("triage mode")!.mode).toBe("skill-only");
  });

  test("'load everything' → conversation", () => {
    expect(detectMode("load everything")!.mode).toBe("conversation");
  });
});

// ── detectMode — no signal ──────────────────────────────────

describe("detectMode — no signal", () => {
  test("ambiguous message returns null", () => {
    expect(detectMode("the quick brown fox")).toBeNull();
  });

  test("empty string returns null", () => {
    expect(detectMode("")).toBeNull();
  });
});

// ── isContextRefresh ────────────────────────────────────────

describe("isContextRefresh", () => {
  test("'refresh context' → true", () => {
    expect(isContextRefresh("please refresh context")).toBe(true);
  });

  test("'reload context' → true", () => {
    expect(isContextRefresh("reload context")).toBe(true);
  });

  test("'pull latest' → true", () => {
    expect(isContextRefresh("pull latest")).toBe(true);
  });

  test("'hello' → false", () => {
    expect(isContextRefresh("hello")).toBe(false);
  });
});

// ── Conversation mode state ─────────────────────────────────

describe("conversation mode state", () => {
  test("defaults to conversation", () => {
    expect(getConversationMode("test-conv")).toBe("conversation");
  });

  test("set and get mode", () => {
    setConversationMode("test-conv", "strategy");
    expect(getConversationMode("test-conv")).toBe("strategy");
  });

  test("clear resets to conversation", () => {
    setConversationMode("test-conv", "deep-work");
    clearConversationMode("test-conv");
    expect(getConversationMode("test-conv")).toBe("conversation");
  });
});

// ── Mode config ─────────────────────────────────────────────

describe("mode config", () => {
  test("getModeConfig returns priorities and budgets", () => {
    const config = getModeConfig();
    expect(config.priorities.conversation).toBeDefined();
    expect(config.budgets.conversation).toBeGreaterThan(0);
    expect(config.defaults).toBeDefined();
  });

  test("getModeSectionPriorities returns section priorities", () => {
    const priorities = getModeSectionPriorities("conversation");
    expect(priorities.soul).toBeDefined();
    expect(typeof priorities.soul).toBe("number");
  });

  test("getModeTokenBudget returns budget for each mode", () => {
    expect(getModeTokenBudget("conversation")).toBe(100_000);
    expect(getModeTokenBudget("strategy")).toBe(150_000);
    expect(getModeTokenBudget("deep-work")).toBe(190_000);
    expect(getModeTokenBudget("skill-only")).toBe(40_000);
  });

  test("updateModeConfig merges priorities", () => {
    updateModeConfig({ conversation: { soul: 5 } });
    expect(getModeSectionPriorities("conversation").soul).toBe(5);
    resetModeConfig();
  });

  test("updateModeConfig merges budgets", () => {
    updateModeConfig(undefined, { conversation: 100_000 });
    expect(getModeTokenBudget("conversation")).toBe(100_000);
    resetModeConfig();
  });

  test("resetModeConfig restores defaults", () => {
    updateModeConfig({ conversation: { soul: 9 } }, { conversation: 1 });
    resetModeConfig();
    expect(getModeSectionPriorities("conversation").soul).toBe(2);
    expect(getModeTokenBudget("conversation")).toBe(100_000);
  });
});

// ── processMessageMode ──────────────────────────────────────

describe("processMessageMode", () => {
  test("detects mode and transitions on high confidence", () => {
    const result = processMessageMode("test-conv", "work on ELLIE-100");
    expect(result.mode).toBe("deep-work");
    expect(result.changed).toBe(true);
    expect(result.detection).not.toBeNull();
  });

  test("returns current mode when no signal", () => {
    setConversationMode("test-conv", "strategy");
    const result = processMessageMode("test-conv", "the quick brown fox");
    expect(result.mode).toBe("strategy");
    expect(result.changed).toBe(false);
  });

  test("does not switch on medium confidence signal", () => {
    setConversationMode("test-conv", "conversation");
    const result = processMessageMode("test-conv", "thanks for that");
    expect(result.changed).toBe(false);
  });
});
