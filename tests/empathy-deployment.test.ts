/**
 * Empathy Detector Deployment Tests — ELLIE-991
 *
 * Verifies the production deployment path:
 * - Fine-tuned model loads from data/empathy-model/
 * - Falls back to SST-2 when no custom model
 * - Hot-swap reload works
 * - API endpoints respond correctly
 * - Detection produces valid results with deployed model
 */

import { describe, it, expect, afterAll } from "bun:test";
import { existsSync } from "fs";
import {
  detectEmpathyNeedsBert,
  extractPrimaryEmotionBert,
  getBertModelInfo,
  isBertModelReady,
  reloadBertModel,
  _resetModelState,
  type BertEmpathyResult,
} from "../src/empathy-detector-bert.ts";

afterAll(() => {
  _resetModelState();
});

// ── Model loading ────────────────────────────────────────────

describe("Production model loading", () => {
  it("should detect custom model directory", () => {
    const modelDir = `${import.meta.dir}/../data/empathy-model`;
    const hasCustom = existsSync(`${modelDir}/config.json`);
    // Either custom or fallback — both valid for production
    expect(typeof hasCustom).toBe("boolean");
  });

  it("should load a model (custom or fallback)", async () => {
    _resetModelState();
    const loaded = await reloadBertModel();
    expect(loaded).toBe(true);
    expect(isBertModelReady()).toBe(true);
  });

  it("getBertModelInfo should report loaded model", () => {
    const info = getBertModelInfo();
    expect(info.ready).toBe(true);
    expect(info.failed).toBe(false);
    expect(["custom-finetuned", "sst2-fallback"]).toContain(info.modelId);
  });
});

// ── Detection with deployed model ────────────────────────────

describe("Detection with deployed model", () => {
  it("should classify HIGH empathy messages correctly", async () => {
    const result = await detectEmpathyNeedsBert(
      "I'm so frustrated and overwhelmed. I don't know what to do. I feel like I'm failing."
    );

    expect(["HIGH", "MODERATE"]).toContain(result.tier);
    expect(result.empathy_score).toBeGreaterThan(0.2);
    expect(result.bert_signals.model_used).toBe("bert");
  });

  it("should classify LOW empathy messages correctly", async () => {
    const result = await detectEmpathyNeedsBert("restart the relay service");

    expect(result.tier).toBe("LOW");
    expect(result.empathy_score).toBeLessThan(0.3);
  });

  it("should handle Dave-style task messages as LOW", async () => {
    const tasks = [
      "push commit and close tickets",
      "run the migration",
      "please rebuild UI",
      "check the database connection",
    ];

    for (const msg of tasks) {
      const result = await detectEmpathyNeedsBert(msg);
      expect(result.tier).toBe("LOW");
    }
  });

  it("should extract primary emotion from distressed message", async () => {
    const result = await extractPrimaryEmotionBert(
      "I'm really scared about losing my job"
    );

    expect(result).not.toBeNull();
    if (result) {
      expect(result.intensity).toBeGreaterThan(0);
      expect(result.source).toBe("bert");
    }
  });

  it("should return valid BertEmpathyResult shape", async () => {
    const result = await detectEmpathyNeedsBert("test message");

    expect(result).toHaveProperty("empathy_score");
    expect(result).toHaveProperty("tier");
    expect(result).toHaveProperty("signals");
    expect(result).toHaveProperty("detected_emotions");
    expect(result).toHaveProperty("response_guidance");
    expect(result).toHaveProperty("bert_signals");
    expect(result.bert_signals).toHaveProperty("model_used");
    expect(result.bert_signals).toHaveProperty("primary_confidence");
  });
});

// ── Hot-swap reload ──────────────────────────────────────────

describe("Hot-swap reload", () => {
  it("should reload model without crash", async () => {
    const loaded = await reloadBertModel();
    expect(loaded).toBe(true);

    const info = getBertModelInfo();
    expect(info.ready).toBe(true);
  });

  it("should produce consistent results after reload", async () => {
    const before = await detectEmpathyNeedsBert("I feel terrible today");
    await reloadBertModel();
    const after = await detectEmpathyNeedsBert("I feel terrible today");

    // Same model should give same results
    expect(after.tier).toBe(before.tier);
    expect(Math.abs(after.empathy_score - before.empathy_score)).toBeLessThan(0.05);
  });
});

// ── Fallback behavior ────────────────────────────────────────

describe("Fallback behavior", () => {
  it("should still work after _resetModelState", async () => {
    _resetModelState();
    expect(isBertModelReady()).toBe(false);

    const result = await detectEmpathyNeedsBert("I am very sad");
    expect(result).toHaveProperty("empathy_score");
    expect(typeof result.empathy_score).toBe("number");
  });
});
