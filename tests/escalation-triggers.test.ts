import { describe, it, expect } from "bun:test";
import { checkEscalation, parseTriggers, DEFAULT_TRIGGERS } from "../src/escalation-triggers.ts";

describe("ELLIE-1079: HITL escalation triggers", () => {
  describe("checkEscalation", () => {
    it("triggers on risky action type", () => {
      const result = checkEscalation({ actionType: "production_deploy" });
      expect(result.triggered).toBe(true);
      expect(result.reason).toContain("production_deploy");
    });

    it("does not trigger on safe action", () => {
      const result = checkEscalation({ actionType: "read_file" });
      expect(result.triggered).toBe(false);
    });

    it("triggers on low confidence", () => {
      const result = checkEscalation({ confidence: 0.3 });
      expect(result.triggered).toBe(true);
      expect(result.reason).toContain("below threshold");
    });

    it("does not trigger on high confidence", () => {
      const result = checkEscalation({ confidence: 0.9 });
      expect(result.triggered).toBe(false);
    });

    it("triggers on high cost", () => {
      const result = checkEscalation({ estimatedCost: 5.0 });
      expect(result.triggered).toBe(true);
      expect(result.reason).toContain("exceeds");
    });

    it("triggers on error", () => {
      const triggers = [{ type: "error_detected" as const }];
      const result = checkEscalation({ triggers, errorDetected: true });
      expect(result.triggered).toBe(true);
    });

    it("uses custom triggers", () => {
      const triggers = [{ type: "confidence_below" as const, threshold: 0.9 }];
      const result = checkEscalation({ triggers, confidence: 0.85 });
      expect(result.triggered).toBe(true);
    });
  });

  describe("parseTriggers", () => {
    it("parses YAML trigger config", () => {
      const yaml = [
        { type: "confidence_below", threshold: 0.6 },
        { type: "action_type", action_types: ["deploy"] },
      ];
      const triggers = parseTriggers(yaml);
      expect(triggers.length).toBe(2);
      expect(triggers[0].threshold).toBe(0.6);
      expect(triggers[1].actionTypes).toContain("deploy");
    });
  });

  describe("defaults", () => {
    it("has default triggers defined", () => {
      expect(DEFAULT_TRIGGERS.length).toBeGreaterThan(0);
    });
  });
});
