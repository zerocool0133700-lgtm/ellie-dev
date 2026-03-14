/**
 * API Route Tests: Orchestration Context — ELLIE-710
 *
 * Tests formatElapsed helper and getOrchestrationContext builder.
 */

import { describe, test, expect, mock } from "bun:test";

// ── Mocks ─────────────────────────────────────────────────────
mock.module("../src/orchestration-tracker.ts", () => ({
  getActiveRunStates: mock(() => []),
}));
mock.module("../src/orchestration-ledger.ts", () => ({
  getRecentEvents: mock(async () => []),
}));

import { getOrchestrationContext, _testing } from "../src/api/orchestration-context.ts";
const { formatElapsed } = _testing;

describe("orchestration-context", () => {
  describe("formatElapsed", () => {
    test("formats seconds", () => {
      expect(formatElapsed(5000)).toBe("5s");
      expect(formatElapsed(0)).toBe("0s");
      expect(formatElapsed(59000)).toBe("59s");
    });

    test("formats minutes", () => {
      expect(formatElapsed(60000)).toBe("1m");
      expect(formatElapsed(120000)).toBe("2m");
      expect(formatElapsed(3540000)).toBe("59m"); // 59 min
    });

    test("formats hours and minutes", () => {
      expect(formatElapsed(3600000)).toBe("1h 0m");
      expect(formatElapsed(5400000)).toBe("1h 30m");
      expect(formatElapsed(7200000)).toBe("2h 0m");
    });

    test("handles large values", () => {
      expect(formatElapsed(86400000)).toBe("24h 0m"); // 24 hours
    });
  });

  describe("getOrchestrationContext", () => {
    test("returns empty string when no active runs or recent events", async () => {
      const result = await getOrchestrationContext();
      expect(result).toBe("");
    });
  });
});
