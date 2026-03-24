/**
 * BERT Empathy Detector Tests — ELLIE-989
 *
 * Tests the BERT-based empathy detection module. Since the model may not be
 * available in CI, tests validate both BERT and keyword fallback paths.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import {
  detectEmpathyNeedsBert,
  extractPrimaryEmotionBert,
  formatBertResponseGuidance,
  isBertModelReady,
  preloadBertModel,
  _resetModelState,
  type BertEmpathyResult,
} from "../src/empathy-detector-bert.ts";

// ── Model loading ────────────────────────────────────────────

describe("BERT Empathy Detector", () => {
  let modelAvailable = false;

  beforeAll(async () => {
    _resetModelState();
    modelAvailable = await preloadBertModel();
  });

  // ── Result shape tests (always pass regardless of model) ──

  describe("result shape", () => {
    it("should return valid BertEmpathyResult for any message", async () => {
      const result = await detectEmpathyNeedsBert("I am feeling really sad today");

      expect(result).toHaveProperty("empathy_score");
      expect(result).toHaveProperty("tier");
      expect(result).toHaveProperty("signals");
      expect(result).toHaveProperty("detected_emotions");
      expect(result).toHaveProperty("response_guidance");
      expect(result).toHaveProperty("bert_signals");

      expect(typeof result.empathy_score).toBe("number");
      expect(result.empathy_score).toBeGreaterThanOrEqual(0);
      expect(result.empathy_score).toBeLessThanOrEqual(1);
      expect(["HIGH", "MODERATE", "LOW"]).toContain(result.tier);
    });

    it("should have bert_signals with correct shape", async () => {
      const result = await detectEmpathyNeedsBert("test message");

      expect(result.bert_signals).toHaveProperty("primary_emotion");
      expect(result.bert_signals).toHaveProperty("primary_confidence");
      expect(result.bert_signals).toHaveProperty("secondary_emotion");
      expect(result.bert_signals).toHaveProperty("secondary_confidence");
      expect(result.bert_signals).toHaveProperty("negative_emotion_total");
      expect(result.bert_signals).toHaveProperty("distress_score");
      expect(result.bert_signals).toHaveProperty("model_used");
      expect(["bert", "keyword"]).toContain(result.bert_signals.model_used);
    });

    it("should report which model was used", async () => {
      const result = await detectEmpathyNeedsBert("hello world");

      if (modelAvailable) {
        expect(result.bert_signals.model_used).toBe("bert");
      } else {
        expect(result.bert_signals.model_used).toBe("keyword");
      }
    });
  });

  // ── Tier classification tests ──────────────────────────────

  describe("tier classification", () => {
    it("should detect high distress message as HIGH or MODERATE", async () => {
      const result = await detectEmpathyNeedsBert(
        "I'm so frustrated and overwhelmed. I don't know what to do. I feel like I'm failing at everything."
      );

      // Both models should recognize this as at least moderate distress
      expect(["HIGH", "MODERATE"]).toContain(result.tier);
      expect(result.empathy_score).toBeGreaterThan(0.2);
    });

    it("should detect task-focused message as LOW", async () => {
      const result = await detectEmpathyNeedsBert(
        "How do I fix this bug in the authentication handler? Can you show me the code?"
      );

      expect(result.tier).toBe("LOW");
      expect(result.empathy_score).toBeLessThan(0.4);
    });

    it("should handle neutral/short messages gracefully", async () => {
      const result = await detectEmpathyNeedsBert("ok");

      expect(result.tier).toBe("LOW");
      expect(result.empathy_score).toBeLessThan(0.3);
    });

    it("should handle empty message", async () => {
      const result = await detectEmpathyNeedsBert("");

      expect(result.tier).toBe("LOW");
      expect(typeof result.empathy_score).toBe("number");
    });
  });

  // ── Primary emotion extraction ─────────────────────────────

  describe("extractPrimaryEmotionBert", () => {
    it("should extract emotion from distressed message", async () => {
      const result = await extractPrimaryEmotionBert("I'm really scared about losing my job");

      expect(result).not.toBeNull();
      if (result) {
        expect(typeof result.emotion).toBe("string");
        expect(result.intensity).toBeGreaterThan(0);
        expect(["bert", "keyword"]).toContain(result.source);
      }
    });

    it("should return null for neutral messages", async () => {
      const result = await extractPrimaryEmotionBert("The meeting is at 3pm tomorrow");

      // May return null or a low-confidence result depending on model
      if (result) {
        expect(result.intensity).toBeLessThan(0.5);
      }
    });

    it("should report source correctly", async () => {
      const result = await extractPrimaryEmotionBert("I am very angry about this situation");

      expect(result).not.toBeNull();
      if (result) {
        if (modelAvailable) {
          expect(result.source).toBe("bert");
        } else {
          expect(result.source).toBe("keyword");
        }
      }
    });
  });

  // ── Guidance formatting ────────────────────────────────────

  describe("formatBertResponseGuidance", () => {
    it("should include BERT signals when model was used", async () => {
      const result = await detectEmpathyNeedsBert(
        "I'm feeling really sad and lonely today"
      );
      const guidance = formatBertResponseGuidance(result);

      expect(guidance).toContain("EMPATHY DETECTION RESULT");
      expect(typeof guidance).toBe("string");
      expect(guidance.length).toBeGreaterThan(50);

      if (result.bert_signals.model_used === "bert") {
        expect(guidance).toContain("BERT sentiment analysis");
        expect(guidance).toContain("negative sentiment");
      }
    });

    it("should produce valid guidance for LOW tier", async () => {
      const result = await detectEmpathyNeedsBert("list all files in the directory");
      const guidance = formatBertResponseGuidance(result);

      expect(guidance).toContain("LOW EMPATHY NEED");
      expect(guidance).toContain("Direct problem-solving");
    });
  });

  // ── Model state management ─────────────────────────────────

  describe("model state", () => {
    it("isBertModelReady should return boolean", () => {
      const ready = isBertModelReady();
      expect(typeof ready).toBe("boolean");
    });

    it("_resetModelState should clear model", async () => {
      _resetModelState();
      expect(isBertModelReady()).toBe(false);

      // Should still work via fallback after reset
      const result = await detectEmpathyNeedsBert("test");
      expect(result).toHaveProperty("empathy_score");
    });
  });

  // ── Keyword fallback tests ─────────────────────────────────

  describe("keyword fallback", () => {
    it("should produce valid results when model is reset", async () => {
      _resetModelState();

      // Force model failure by checking before reload
      const result = await detectEmpathyNeedsBert(
        "I'm so frustrated and overwhelmed"
      );

      // Should still detect via keyword fallback
      expect(result).toHaveProperty("empathy_score");
      expect(result.empathy_score).toBeGreaterThan(0);
      expect(result.detected_emotions.length).toBeGreaterThan(0);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────

  describe("edge cases", () => {
    it("should handle very long messages", async () => {
      const longMessage = "I am feeling very sad. ".repeat(200);
      const result = await detectEmpathyNeedsBert(longMessage);

      expect(result).toHaveProperty("empathy_score");
      expect(typeof result.empathy_score).toBe("number");
    });

    it("should handle special characters", async () => {
      const result = await detectEmpathyNeedsBert(
        "I'm 😢😢😢 so sad!!! Why??? @#$%"
      );

      expect(result).toHaveProperty("empathy_score");
    });

    it("should handle non-English text gracefully", async () => {
      const result = await detectEmpathyNeedsBert("Je suis tres triste aujourd'hui");

      // Should not crash — may produce keyword fallback results
      expect(result).toHaveProperty("empathy_score");
      expect(typeof result.empathy_score).toBe("number");
    });

    it("should score consistency: sad < angry+scared+hopeless", async () => {
      const mild = await detectEmpathyNeedsBert("I feel a bit down today");
      const severe = await detectEmpathyNeedsBert(
        "I'm terrified and angry and I feel completely hopeless. I don't know what to do."
      );

      expect(severe.empathy_score).toBeGreaterThan(mild.empathy_score);
    });
  });

  // ── Real-world Dave messages ───────────────────────────────

  describe("real-world messages", () => {
    it("should handle Dave's typical task instructions as LOW", async () => {
      const messages = [
        "build the empathy detector MVP now",
        "please restart the relay",
        "push commit and close tickets",
        "run the migration",
      ];

      for (const msg of messages) {
        const result = await detectEmpathyNeedsBert(msg);
        expect(result.tier).toBe("LOW");
      }
    });

    it("should detect frustration in debugging context", async () => {
      const result = await detectEmpathyNeedsBert(
        "I'm so frustrated and exhausted. This keeps breaking every time I deploy. I've been struggling with this for hours and nothing works."
      );

      // With explicit emotion keywords, both BERT and keyword should detect this
      expect(["HIGH", "MODERATE"]).toContain(result.tier);
    });
  });
});
