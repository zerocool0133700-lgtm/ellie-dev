/**
 * ELLIE-559 — session-compaction.ts tests
 *
 * Tests context pressure calculation, notification deduplication, and compaction notices.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  checkContextPressure,
  shouldNotify,
  getCompactionNotice,
  _resetNotifiedForTesting,
  type ContextPressure,
} from "../src/api/session-compaction.ts";
import type { BuildMetrics } from "../src/prompt-builder.ts";

// ── Helpers ──────────────────────────────────────────────────

function makeMetrics(totalTokens: number, budget: number): BuildMetrics {
  return {
    totalTokens,
    budget,
    sections: [],
    buildTimeMs: 0,
  } as unknown as BuildMetrics;
}

// ── checkContextPressure ─────────────────────────────────────

describe("checkContextPressure", () => {
  test("returns ok when under 70%", () => {
    const result = checkContextPressure(makeMetrics(5000, 10000));
    expect(result.level).toBe("ok");
    expect(result.pct).toBe(0.5);
    expect(result.tokensUsed).toBe(5000);
    expect(result.budget).toBe(10000);
  });

  test("returns warn at 70%", () => {
    const result = checkContextPressure(makeMetrics(7000, 10000));
    expect(result.level).toBe("warn");
  });

  test("returns warn between 70% and 85%", () => {
    const result = checkContextPressure(makeMetrics(7500, 10000));
    expect(result.level).toBe("warn");
    expect(result.pct).toBe(0.75);
  });

  test("returns critical at 85%", () => {
    const result = checkContextPressure(makeMetrics(8500, 10000));
    expect(result.level).toBe("critical");
  });

  test("returns critical above 85%", () => {
    const result = checkContextPressure(makeMetrics(9500, 10000));
    expect(result.level).toBe("critical");
    expect(result.pct).toBe(0.95);
  });

  test("returns ok with zero budget", () => {
    const result = checkContextPressure(makeMetrics(5000, 0));
    expect(result.level).toBe("ok");
    expect(result.pct).toBe(0);
    expect(result.budget).toBe(0);
  });
});

// ── shouldNotify ─────────────────────────────────────────────

describe("shouldNotify", () => {
  beforeEach(() => {
    _resetNotifiedForTesting();
  });

  test("returns false for ok level", () => {
    expect(shouldNotify("conv-1", "ok")).toBe(false);
  });

  test("returns false for undefined conversationId", () => {
    expect(shouldNotify(undefined, "warn")).toBe(false);
  });

  test("returns true first time for warn", () => {
    expect(shouldNotify("conv-1", "warn")).toBe(true);
  });

  test("returns false second time for same conversation + level", () => {
    shouldNotify("conv-1", "warn");
    expect(shouldNotify("conv-1", "warn")).toBe(false);
  });

  test("different conversations notified independently", () => {
    expect(shouldNotify("conv-1", "warn")).toBe(true);
    expect(shouldNotify("conv-2", "warn")).toBe(true);
  });

  test("same conversation notified for different levels", () => {
    expect(shouldNotify("conv-1", "warn")).toBe(true);
    expect(shouldNotify("conv-1", "critical")).toBe(true);
  });

  test("reset clears notification state", () => {
    shouldNotify("conv-1", "warn");
    _resetNotifiedForTesting();
    expect(shouldNotify("conv-1", "warn")).toBe(true);
  });
});

// ── getCompactionNotice ──────────────────────────────────────

describe("getCompactionNotice", () => {
  test("critical notice includes auto-checkpointed", () => {
    const pressure: ContextPressure = { level: "critical", pct: 0.85, tokensUsed: 8500, budget: 10000 };
    const notice = getCompactionNotice(pressure);
    expect(notice).toContain("auto-checkpointed");
    expect(notice).toContain("85%");
  });

  test("warn notice suggests fresh session", () => {
    const pressure: ContextPressure = { level: "warn", pct: 0.65, tokensUsed: 6500, budget: 10000 };
    const notice = getCompactionNotice(pressure);
    expect(notice).toContain("fresh session");
    expect(notice).toContain("65%");
  });

  test("notice starts with separator", () => {
    const pressure: ContextPressure = { level: "warn", pct: 0.7, tokensUsed: 7000, budget: 10000 };
    expect(getCompactionNotice(pressure)).toContain("---");
  });

  test("percentage is rounded", () => {
    const pressure: ContextPressure = { level: "critical", pct: 0.873, tokensUsed: 8730, budget: 10000 };
    expect(getCompactionNotice(pressure)).toContain("87%");
  });
});
