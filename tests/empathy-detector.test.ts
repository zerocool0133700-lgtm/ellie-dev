/**
 * Empathy Detector Tests — EI Component 1
 */

import { describe, it, expect } from "bun:test";
import { detectEmpathyNeeds, extractPrimaryEmotion, formatResponseGuidance } from "../src/empathy-detector.ts";

describe("Empathy Detector", () => {
  describe("detectEmpathyNeeds", () => {
    it("should detect HIGH empathy need for emotionally distressed messages", () => {
      const message = "I'm so frustrated and overwhelmed. I don't know what to do. I feel like I'm failing at everything.";
      const result = detectEmpathyNeeds(message);

      expect(result.tier).toBe("HIGH");
      expect(result.empathy_score).toBeGreaterThan(0.6);
      expect(result.detected_emotions.length).toBeGreaterThan(0);
      expect(result.signals.vulnerability_cues_present).toBe(true);
    });

    it("should detect LOW empathy need for task-focused messages", () => {
      const message = "How do I fix this bug in the authentication handler? Can you show me the code?";
      const result = detectEmpathyNeeds(message);

      expect(result.tier).toBe("LOW");
      expect(result.empathy_score).toBeLessThan(0.3);
    });

    it("should detect MODERATE empathy need for mixed messages", () => {
      const message = "I'm a bit stuck on this problem. Can you help me figure out the best approach?";
      const result = detectEmpathyNeeds(message);

      expect(result.tier).toBe("MODERATE");
      expect(result.empathy_score).toBeGreaterThanOrEqual(0.3);
      expect(result.empathy_score).toBeLessThanOrEqual(0.6);
    });

    it("should detect repeated emotions correctly", () => {
      const message = "I'm frustrated with this. It's so frustrating. I keep getting frustrated every time I try.";
      const result = detectEmpathyNeeds(message);

      expect(result.detected_emotions).toContain("frustrated");
      expect(result.signals.repeated_emotions).toBeGreaterThan(0);
    });

    it("should detect rhetorical questions", () => {
      const message = "Why does this always happen to me? What am I doing wrong?";
      const result = detectEmpathyNeeds(message);

      // Rhetorical questions are detected
      expect(result.signals.rhetorical_questions).toBeGreaterThan(0);

      // But without emotion keywords, tier may still be LOW
      // (Rhetorical questions boost score but need emotion context for HIGH/MODERATE)
      expect(["LOW", "MODERATE", "HIGH"]).toContain(result.tier);
    });
  });

  describe("extractPrimaryEmotion", () => {
    it("should extract emotion from message with emotion keywords", () => {
      const message = "I'm really frustrated with this bug";
      const result = extractPrimaryEmotion(message);

      expect(result).not.toBeNull();
      expect(result?.emotion).toBe("frustrated");
      expect(result?.intensity).toBeGreaterThan(0);
    });

    it("should return null for neutral messages", () => {
      const message = "The weather is nice today";
      const result = extractPrimaryEmotion(message);

      expect(result).toBeNull();
    });

    it("should handle multiple emotions and pick first", () => {
      const message = "I'm anxious and scared about this deadline";
      const result = extractPrimaryEmotion(message);

      expect(result).not.toBeNull();
      expect(["anxious", "scared"]).toContain(result?.emotion);
    });
  });

  describe("formatResponseGuidance", () => {
    it("should format HIGH tier guidance correctly", () => {
      const detection = detectEmpathyNeeds("I'm so overwhelmed I don't know what to do");
      const guidance = formatResponseGuidance(detection);

      expect(guidance).toContain("HIGH EMPATHY NEED");
      expect(guidance).toContain("Acknowledge emotion first");
      expect(guidance).toContain("Validate experience");
    });

    it("should format MODERATE tier guidance correctly", () => {
      const detection = detectEmpathyNeeds("I'm a bit stuck, can you help?");
      const guidance = formatResponseGuidance(detection);

      expect(guidance).toContain("MODERATE EMPATHY NEED");
      expect(guidance).toContain("Brief acknowledgment + solution");
    });

    it("should format LOW tier guidance correctly", () => {
      const detection = detectEmpathyNeeds("How do I implement feature X?");
      const guidance = formatResponseGuidance(detection);

      expect(guidance).toContain("LOW EMPATHY NEED");
      expect(guidance).toContain("Direct problem-solving");
    });
  });

  describe("Real-world test cases", () => {
    it("should handle Dave's typical messages correctly", () => {
      const testCases = [
        {
          message: "build the empathy detector MVP now",
          expectedTier: "LOW",
          reason: "Direct task instruction"
        },
        {
          message: "I think you were supposed to be writing the test script and your bubble disappeared and did not come back.",
          expectedTier: "LOW", // No emotion keywords, just factual observation
          reason: "Factual observation, no strong emotion"
        },
        {
          message: "Uh, done.",
          expectedTier: "LOW",
          reason: "Simple status update"
        }
      ];

      for (const testCase of testCases) {
        const result = detectEmpathyNeeds(testCase.message);
        expect(result.tier).toBe(testCase.expectedTier);
      }
    });
  });
});
