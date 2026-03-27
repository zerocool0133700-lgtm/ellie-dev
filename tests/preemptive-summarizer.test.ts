import { describe, it, expect } from "bun:test";
import {
  shouldTrigger,
  DEFAULT_TRIGGER_THRESHOLD,
  KEEP_RECENT_TURNS,
  type ConversationTurn,
} from "../src/preemptive-summarizer.ts";

describe("ELLIE-1058: Preemptive summarization", () => {
  describe("shouldTrigger", () => {
    it("triggers at 80% of budget", () => {
      expect(shouldTrigger(80_000, 100_000)).toBe(true);
    });

    it("does not trigger below threshold", () => {
      expect(shouldTrigger(50_000, 100_000)).toBe(false);
    });

    it("triggers at exactly threshold", () => {
      expect(shouldTrigger(80_000, 100_000, 0.8)).toBe(true);
    });

    it("respects custom threshold", () => {
      expect(shouldTrigger(60_000, 100_000, 0.5)).toBe(true);
      expect(shouldTrigger(40_000, 100_000, 0.5)).toBe(false);
    });
  });

  describe("summarizeConversationHistory", () => {
    it("skips if turns <= keepRecent", async () => {
      const { summarizeConversationHistory } = await import("../src/preemptive-summarizer.ts");
      const turns: ConversationTurn[] = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ];
      const result = await summarizeConversationHistory(turns, 5);
      expect(result.triggered).toBe(false);
      expect(result.turnsConsumed).toBe(0);
    });
  });

  describe("constants", () => {
    it("default trigger threshold is 0.8", () => {
      expect(DEFAULT_TRIGGER_THRESHOLD).toBe(0.8);
    });

    it("keeps last 5 turns by default", () => {
      expect(KEEP_RECENT_TURNS).toBe(5);
    });
  });

  describe("applyPreemptiveSummarization", () => {
    it("returns unchanged turns when below threshold", async () => {
      const { applyPreemptiveSummarization } = await import("../src/preemptive-summarizer.ts");
      const turns: ConversationTurn[] = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ];
      const { turns: result, result: summary } = await applyPreemptiveSummarization(
        turns, 10_000, 100_000
      );
      expect(result).toEqual(turns);
      expect(summary.triggered).toBe(false);
    });
  });
});
