/**
 * ELLIE-528 — Extend context monitoring to all agent paths.
 *
 * Tests the pure functions in session-compaction.ts that power
 * context pressure monitoring across every dispatch path:
 *
 * - checkContextPressure() — ok / warn / critical classification
 * - shouldNotify()         — per-conversation deduplication
 * - getCompactionNotice()  — output format at each level
 * - checkpointSessionToForest() — calls writeMemory with correct shape
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mock ellie-forest (writeMemory) ───────────────────────────────────────────

const mockWriteMemory = mock(() => Promise.resolve({ id: "m1" }));

mock.module("../../ellie-forest/src/index", () => ({
  writeMemory: mockWriteMemory,
  createLink: mock(() => Promise.resolve({})),
  getAgent: mock(() => Promise.resolve(null)),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import {
  checkContextPressure,
  shouldNotify,
  getCompactionNotice,
  checkpointSessionToForest,
  _resetNotifiedForTesting,
  type ContextPressure,
  type CheckpointOpts,
} from "../src/api/session-compaction.ts";
import type { BuildMetrics } from "../src/prompt-builder.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMetrics(tokensUsed: number, budget: number): BuildMetrics {
  return {
    totalTokens: tokensUsed,
    budget,
    sections: [
      { label: "system", tokens: Math.floor(tokensUsed * 0.4) },
      { label: "context", tokens: Math.floor(tokensUsed * 0.3) },
      { label: "memory", tokens: Math.floor(tokensUsed * 0.2) },
      { label: "history", tokens: Math.floor(tokensUsed * 0.07) },
      { label: "docket", tokens: Math.floor(tokensUsed * 0.03) },
    ],
    sectionCount: 5,
    creature: "general",
    mode: "default",
  };
}

// ── checkContextPressure ──────────────────────────────────────────────────────

describe("checkContextPressure", () => {
  test("returns ok when below 60%", () => {
    const p = checkContextPressure(makeMetrics(50_000, 100_000));
    expect(p.level).toBe("ok");
    expect(p.pct).toBeCloseTo(0.5);
    expect(p.tokensUsed).toBe(50_000);
    expect(p.budget).toBe(100_000);
  });

  test("returns ok at exactly 59.9%", () => {
    const p = checkContextPressure(makeMetrics(59_900, 100_000));
    expect(p.level).toBe("ok");
  });

  test("returns warn at exactly 60%", () => {
    const p = checkContextPressure(makeMetrics(60_000, 100_000));
    expect(p.level).toBe("warn");
  });

  test("returns warn between 60% and 80%", () => {
    const p = checkContextPressure(makeMetrics(75_000, 100_000));
    expect(p.level).toBe("warn");
    expect(p.pct).toBeCloseTo(0.75);
  });

  test("returns critical at exactly 80%", () => {
    const p = checkContextPressure(makeMetrics(80_000, 100_000));
    expect(p.level).toBe("critical");
  });

  test("returns critical above 80%", () => {
    const p = checkContextPressure(makeMetrics(95_000, 100_000));
    expect(p.level).toBe("critical");
    expect(p.pct).toBeCloseTo(0.95);
  });

  test("returns ok when budget is 0 (no budget set)", () => {
    const p = checkContextPressure(makeMetrics(50_000, 0));
    expect(p.level).toBe("ok");
    expect(p.pct).toBe(0);
  });

  test("pct is a fraction (not percentage)", () => {
    const p = checkContextPressure(makeMetrics(75_000, 100_000));
    // 0.75 not 75
    expect(p.pct).toBeGreaterThan(0);
    expect(p.pct).toBeLessThan(1);
  });
});

// ── shouldNotify ──────────────────────────────────────────────────────────────

describe("shouldNotify", () => {
  beforeEach(() => {
    _resetNotifiedForTesting();
  });

  test("returns false for ok level", () => {
    expect(shouldNotify("convo-1", "ok")).toBe(false);
  });

  test("returns false when conversationId is undefined", () => {
    expect(shouldNotify(undefined, "warn")).toBe(false);
  });

  test("returns true on first warn notification", () => {
    expect(shouldNotify("convo-1", "warn")).toBe(true);
  });

  test("returns false on repeated warn for same conversation", () => {
    shouldNotify("convo-1", "warn"); // first — true
    expect(shouldNotify("convo-1", "warn")).toBe(false);
  });

  test("returns true for critical even after warn was already notified", () => {
    shouldNotify("convo-1", "warn");
    expect(shouldNotify("convo-1", "critical")).toBe(true);
  });

  test("returns false on repeated critical for same conversation", () => {
    shouldNotify("convo-1", "critical");
    expect(shouldNotify("convo-1", "critical")).toBe(false);
  });

  test("different conversations are tracked independently", () => {
    shouldNotify("convo-1", "warn");
    // convo-2 hasn't been warned yet
    expect(shouldNotify("convo-2", "warn")).toBe(true);
  });

  test("all paths share the same deduplication state", () => {
    // Simulate ellie-chat path notifying first
    shouldNotify("shared-convo", "warn");
    // Telegram path trying to notify same conversation — should be deduped
    expect(shouldNotify("shared-convo", "warn")).toBe(false);
  });

  test("reset clears all state", () => {
    shouldNotify("convo-1", "warn");
    _resetNotifiedForTesting();
    expect(shouldNotify("convo-1", "warn")).toBe(true);
  });
});

// ── getCompactionNotice ───────────────────────────────────────────────────────

describe("getCompactionNotice", () => {
  const warnPressure: ContextPressure = { level: "warn", pct: 0.65, tokensUsed: 65_000, budget: 100_000 };
  const criticalPressure: ContextPressure = { level: "critical", pct: 0.85, tokensUsed: 85_000, budget: 100_000 };

  test("warn notice includes percentage", () => {
    const notice = getCompactionNotice(warnPressure);
    expect(notice).toContain("65%");
  });

  test("warn notice uses 💡 emoji", () => {
    const notice = getCompactionNotice(warnPressure);
    expect(notice).toContain("💡");
  });

  test("warn notice does not claim checkpointing happened", () => {
    const notice = getCompactionNotice(warnPressure);
    expect(notice).not.toContain("checkpointed");
  });

  test("critical notice uses ⚠️ emoji", () => {
    const notice = getCompactionNotice(criticalPressure);
    expect(notice).toContain("⚠️");
  });

  test("critical notice includes percentage", () => {
    const notice = getCompactionNotice(criticalPressure);
    expect(notice).toContain("85%");
  });

  test("critical notice mentions checkpointing", () => {
    const notice = getCompactionNotice(criticalPressure);
    expect(notice).toContain("checkpointed");
  });

  test("notice is appended with separator (starts with newlines and ---)", () => {
    const notice = getCompactionNotice(warnPressure);
    expect(notice.startsWith("\n\n---\n")).toBe(true);
  });

  test("percentage is rounded to integer", () => {
    const p: ContextPressure = { level: "warn", pct: 0.6666, tokensUsed: 66_660, budget: 100_000 };
    const notice = getCompactionNotice(p);
    // Should show 67%, not 66.66%
    expect(notice).toContain("67%");
    expect(notice).not.toContain("66.6");
  });
});

// ── checkpointSessionToForest ─────────────────────────────────────────────────

describe("checkpointSessionToForest", () => {
  beforeEach(() => {
    mockWriteMemory.mockReset();
    mockWriteMemory.mockImplementation(() => Promise.resolve({ id: "m1" }));
  });

  const baseOpts: CheckpointOpts = {
    conversationId: "convo-abc",
    agentName: "general",
    mode: "default",
    workItemId: "ELLIE-528",
    pressure: { level: "critical", pct: 0.85, tokensUsed: 85_000, budget: 100_000 },
    sections: [
      { label: "system", tokens: 40_000 },
      { label: "context", tokens: 20_000 },
      { label: "memory", tokens: 15_000 },
      { label: "history", tokens: 7_000 },
      { label: "docket", tokens: 3_000 },
    ],
    lastUserMessage: "Can you help me refactor this module?",
  };

  test("calls writeMemory once", async () => {
    await checkpointSessionToForest(baseOpts);
    expect(mockWriteMemory).toHaveBeenCalledTimes(1);
  });

  test("writes type=finding", async () => {
    await checkpointSessionToForest(baseOpts);
    const [arg] = mockWriteMemory.mock.calls[0] as [any];
    expect(arg.type).toBe("finding");
  });

  test("includes session-checkpoint tag", async () => {
    await checkpointSessionToForest(baseOpts);
    const [arg] = mockWriteMemory.mock.calls[0] as [any];
    expect(arg.tags).toContain("session-checkpoint");
  });

  test("includes compaction tag", async () => {
    await checkpointSessionToForest(baseOpts);
    const [arg] = mockWriteMemory.mock.calls[0] as [any];
    expect(arg.tags).toContain("compaction");
  });

  test("content includes agent name", async () => {
    await checkpointSessionToForest(baseOpts);
    const [arg] = mockWriteMemory.mock.calls[0] as [any];
    expect(arg.content).toContain("general");
  });

  test("content includes pressure percentage", async () => {
    await checkpointSessionToForest(baseOpts);
    const [arg] = mockWriteMemory.mock.calls[0] as [any];
    expect(arg.content).toContain("85%");
  });

  test("content includes work item id", async () => {
    await checkpointSessionToForest(baseOpts);
    const [arg] = mockWriteMemory.mock.calls[0] as [any];
    expect(arg.content).toContain("ELLIE-528");
  });

  test("content includes truncated last user message", async () => {
    await checkpointSessionToForest(baseOpts);
    const [arg] = mockWriteMemory.mock.calls[0] as [any];
    expect(arg.content).toContain("Can you help me refactor this module?");
  });

  test("metadata includes conversation_id", async () => {
    await checkpointSessionToForest(baseOpts);
    const [arg] = mockWriteMemory.mock.calls[0] as [any];
    expect(arg.metadata.conversation_id).toBe("convo-abc");
  });

  test("metadata.checkpoint is true", async () => {
    await checkpointSessionToForest(baseOpts);
    const [arg] = mockWriteMemory.mock.calls[0] as [any];
    expect(arg.metadata.checkpoint).toBe(true);
  });

  test("metadata includes pressure_pct", async () => {
    await checkpointSessionToForest(baseOpts);
    const [arg] = mockWriteMemory.mock.calls[0] as [any];
    expect(arg.metadata.pressure_pct).toBeCloseTo(0.85);
  });

  test("works without workItemId (optional)", async () => {
    const opts = { ...baseOpts, workItemId: null };
    await checkpointSessionToForest(opts);
    const [arg] = mockWriteMemory.mock.calls[0] as [any];
    expect(arg.content).not.toContain("Work item:");
  });

  test("top 5 sections appear in content (sorted by tokens)", async () => {
    await checkpointSessionToForest(baseOpts);
    const [arg] = mockWriteMemory.mock.calls[0] as [any];
    // "system" has most tokens (40k) — should be first
    expect(arg.content).toContain("system: 40000");
  });

  test("long lastUserMessage is truncated to 400 chars", async () => {
    // Use a unique marker that won't appear elsewhere in the content
    const marker = "ZZZZ";
    const longMsg = marker + "Q".repeat(600);
    const opts = { ...baseOpts, lastUserMessage: longMsg };
    await checkpointSessionToForest(opts);
    const [arg] = mockWriteMemory.mock.calls[0] as [any];
    // Truncated to 400 chars, so the 600 Q's are cut
    const qCount = (arg.content.match(/Q/g) || []).length;
    expect(qCount).toBeLessThanOrEqual(396); // 400 - len(marker)
    expect(arg.content).toContain(marker); // marker itself is preserved
  });
});

// ── Integration: all paths share shouldNotify state ──────────────────────────

describe("cross-path deduplication", () => {
  beforeEach(() => {
    _resetNotifiedForTesting();
  });

  test("warn on ellie-chat blocks warn on telegram for same conversation", () => {
    // ellie-chat general path fires first
    const firstNotify = shouldNotify("convo-shared", "warn");
    expect(firstNotify).toBe(true);

    // telegram text path would fire for same conversation
    const secondNotify = shouldNotify("convo-shared", "warn");
    expect(secondNotify).toBe(false);
  });

  test("different conversations each get their own warn notification", () => {
    expect(shouldNotify("ellie-chat-convo", "warn")).toBe(true);
    expect(shouldNotify("telegram-convo", "warn")).toBe(true);
    expect(shouldNotify("gchat-convo", "warn")).toBe(true);
  });

  test("critical fires independently from warn for the same conversation", () => {
    shouldNotify("convo-X", "warn");
    expect(shouldNotify("convo-X", "critical")).toBe(true);
  });
});
