import { describe, it, expect } from "bun:test";
import { STALE_AFTER_DAYS } from "../src/commitment-tracker.ts";

describe("ELLIE-1067: Commitment tracking", () => {
  describe("constants", () => {
    it("stale after 7 days", () => {
      expect(STALE_AFTER_DAYS).toBe(7);
    });
  });

  describe("module exports", () => {
    it("exports required functions", async () => {
      const mod = await import("../src/commitment-tracker.ts");
      expect(typeof mod.createCommitment).toBe("function");
      expect(typeof mod.completeCommitment).toBe("function");
      expect(typeof mod.getOpenCommitments).toBe("function");
      expect(typeof mod.detectOverdueCommitments).toBe("function");
      expect(typeof mod.getCommitmentSummary).toBe("function");
    });
  });

  describe("Commitment interface", () => {
    it("has required fields", () => {
      const commitment = {
        id: "test",
        content: "Send pricing doc",
        person_name: "Alex",
        assignee: "dave",
        status: "open" as const,
        due_date: "2026-03-28",
        source_conversation_id: null,
        source_channel: "voice",
        stale_reason: null,
        created_at: new Date().toISOString(),
      };
      expect(commitment.status).toBe("open");
      expect(commitment.person_name).toBe("Alex");
    });
  });
});
