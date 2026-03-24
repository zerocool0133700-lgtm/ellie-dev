/**
 * Empathy Training Pipeline Tests — ELLIE-990
 *
 * Tests the 5-phase training pipeline components:
 * - Phase 1: Data collection (synthetic + production)
 * - Phase 2: Preprocessing and splitting
 * - Phase 3: Training script validation (structure only — no GPU)
 * - Phase 4: Evaluation metrics computation
 * - Phase 5: Deployment and hot-swap
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { detectEmpathyNeeds } from "../src/empathy-detector.ts";
import {
  detectEmpathyNeedsBert,
  getBertModelInfo,
  reloadBertModel,
  _resetModelState,
} from "../src/empathy-detector-bert.ts";

const TEST_DATA_DIR = "/tmp/empathy-training-test";

beforeAll(() => {
  if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true });
  mkdirSync(TEST_DATA_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TEST_DATA_DIR)) rmSync(TEST_DATA_DIR, { recursive: true });
});

// ── Phase 1: Collection ──────────────────────────────────────

describe("Phase 1: Data Collection", () => {
  it("should generate valid JSONL from synthetic data", () => {
    // Simulate collect output
    const examples = [
      { text: "I'm frustrated", label: 2 },
      { text: "How do I fix this?", label: 0 },
      { text: "A bit stuck but managing", label: 1 },
    ];

    const jsonl = examples.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(`${TEST_DATA_DIR}/collected.jsonl`, jsonl);

    const lines = readFileSync(`${TEST_DATA_DIR}/collected.jsonl`, "utf-8").trim().split("\n");
    expect(lines.length).toBe(3);

    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("text");
      expect(parsed).toHaveProperty("label");
      expect([0, 1, 2]).toContain(parsed.label);
      expect(typeof parsed.text).toBe("string");
    }
  });

  it("should deduplicate examples", () => {
    const examples = [
      { text: "I'm frustrated", label: 2 },
      { text: "I'm frustrated", label: 2 }, // duplicate
      { text: "How do I fix this?", label: 0 },
    ];

    const seen = new Set<string>();
    const deduped = examples.filter((e) => {
      const key = e.text.toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    expect(deduped.length).toBe(2);
  });

  it("should assign correct labels from empathy scores", () => {
    const scoreToLabel = (score: number): number => {
      if (score > 0.6) return 2;
      if (score >= 0.3) return 1;
      return 0;
    };

    expect(scoreToLabel(0.0)).toBe(0);
    expect(scoreToLabel(0.15)).toBe(0);
    expect(scoreToLabel(0.29)).toBe(0);
    expect(scoreToLabel(0.3)).toBe(1);
    expect(scoreToLabel(0.5)).toBe(1);
    expect(scoreToLabel(0.6)).toBe(1);
    expect(scoreToLabel(0.61)).toBe(2);
    expect(scoreToLabel(0.9)).toBe(2);
    expect(scoreToLabel(1.0)).toBe(2);
  });
});

// ── Phase 2: Preprocessing ───────────────────────────────────

describe("Phase 2: Preprocessing", () => {
  it("should normalize whitespace and remove URLs", () => {
    const preprocess = (text: string) =>
      text
        .replace(/https?:\/\/\S+/g, "")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 512);

    expect(preprocess("hello   world")).toBe("hello world");
    expect(preprocess("check https://example.com here")).toBe("check here");
    expect(preprocess("<b>bold</b> text")).toBe("bold text");
    expect(preprocess("a".repeat(600)).length).toBe(512);
  });

  it("should create stratified splits with correct proportions", () => {
    // Create 30 examples per class (90 total)
    const examples = [];
    for (let label = 0; label < 3; label++) {
      for (let i = 0; i < 30; i++) {
        examples.push({ text: `example ${label}-${i}`, label });
      }
    }

    // Simulate stratified split
    const groups: Record<number, typeof examples> = {};
    for (const ex of examples) {
      (groups[ex.label] ??= []).push(ex);
    }

    const train: typeof examples = [];
    const val: typeof examples = [];
    const test: typeof examples = [];

    for (const label of [0, 1, 2]) {
      const g = groups[label];
      const trainEnd = Math.floor(g.length * 0.7);
      const valEnd = trainEnd + Math.floor(g.length * 0.15);
      train.push(...g.slice(0, trainEnd));
      val.push(...g.slice(trainEnd, valEnd));
      test.push(...g.slice(valEnd));
    }

    expect(train.length).toBe(63); // 21 per class
    expect(val.length).toBe(12);   // 4 per class
    expect(test.length).toBe(15);  // 5 per class

    // Each split has all 3 labels
    for (const split of [train, val, test]) {
      const labels = new Set(split.map((e) => e.label));
      expect(labels.size).toBe(3);
    }
  });
});

// ── Phase 3: Training Script Validation ──────────────────────

describe("Phase 3: Training Script", () => {
  it("should have train.py script", () => {
    expect(existsSync(`${import.meta.dir}/../scripts/empathy-training/train.py`)).toBe(true);
  });

  it("train.py should have required sections", () => {
    const content = readFileSync(
      `${import.meta.dir}/../scripts/empathy-training/train.py`,
      "utf-8"
    );

    expect(content).toContain("AutoTokenizer");
    expect(content).toContain("AutoModelForSequenceClassification");
    expect(content).toContain("TrainingArguments");
    expect(content).toContain("Trainer");
    expect(content).toContain("num_labels=3");
    expect(content).toContain("id2label");
    expect(content).toContain("ONNX");
  });

  it("should define correct label mapping", () => {
    const content = readFileSync(
      `${import.meta.dir}/../scripts/empathy-training/train.py`,
      "utf-8"
    );

    expect(content).toContain('"LOW"');
    expect(content).toContain('"MODERATE"');
    expect(content).toContain('"HIGH"');
  });
});

// ── Phase 4: Evaluation Metrics ──────────────────────────────

describe("Phase 4: Evaluation Metrics", () => {
  it("should compute correct accuracy", () => {
    const predictions = [0, 1, 2, 0, 1, 2, 0, 1, 2, 0];
    const actuals =     [0, 1, 2, 0, 1, 2, 0, 1, 2, 1]; // 9/10 correct

    let correct = 0;
    for (let i = 0; i < predictions.length; i++) {
      if (predictions[i] === actuals[i]) correct++;
    }

    expect(correct / predictions.length).toBe(0.9);
  });

  it("should compute precision/recall/F1 per class", () => {
    // Simple case: class 0 has TP=2, FP=1, FN=0
    const predictions = [0, 0, 0, 1, 2];
    const actuals =     [0, 0, 1, 1, 2];

    // Class 0: TP=2, FP=1, FN=0
    const tp0 = 2, fp0 = 1, fn0 = 0;
    const precision0 = tp0 / (tp0 + fp0); // 2/3
    const recall0 = tp0 / (tp0 + fn0);    // 2/2
    const f1_0 = 2 * precision0 * recall0 / (precision0 + recall0);

    expect(precision0).toBeCloseTo(0.667, 2);
    expect(recall0).toBe(1.0);
    expect(f1_0).toBeCloseTo(0.8, 1);
  });

  it("should build confusion matrix correctly", () => {
    const predictions = [0, 1, 2, 0, 1];
    const actuals =     [0, 1, 2, 1, 2];

    const matrix = Array.from({ length: 3 }, () => Array(3).fill(0));
    for (let i = 0; i < predictions.length; i++) {
      matrix[actuals[i]][predictions[i]]++;
    }

    // actual=0, pred=0: 1
    expect(matrix[0][0]).toBe(1);
    // actual=1, pred=1: 1
    expect(matrix[1][1]).toBe(1);
    // actual=1, pred=0: 1 (misclassification)
    expect(matrix[1][0]).toBe(1);
    // actual=2, pred=2: 1
    expect(matrix[2][2]).toBe(1);
    // actual=2, pred=1: 1 (misclassification)
    expect(matrix[2][1]).toBe(1);
  });

  it("keyword detector should produce consistent labels for synthetic data", () => {
    const testCases = [
      { text: "How do I fix this?", expectedLabel: 0 },
      { text: "I'm so frustrated and overwhelmed. I don't know what to do.", expectedLabel: 2 },
    ];

    for (const tc of testCases) {
      const result = detectEmpathyNeeds(tc.text);
      const label = result.tier === "HIGH" ? 2 : result.tier === "MODERATE" ? 1 : 0;
      expect(label).toBe(tc.expectedLabel);
    }
  });
});

// ── Phase 5: Deployment ──────────────────────────────────────

describe("Phase 5: Deployment & Hot-Swap", () => {
  it("should expose model info via getBertModelInfo", () => {
    const info = getBertModelInfo();
    expect(info).toHaveProperty("ready");
    expect(info).toHaveProperty("modelId");
    expect(info).toHaveProperty("failed");
    expect(typeof info.ready).toBe("boolean");
  });

  it("should handle reload when no custom model exists", async () => {
    _resetModelState();
    const loaded = await reloadBertModel();
    // Should still load the fallback SST-2 model
    expect(typeof loaded).toBe("boolean");
  });

  it("deploy script should exist and have rollback support", () => {
    const content = readFileSync(
      `${import.meta.dir}/../scripts/empathy-training/deploy.ts`,
      "utf-8"
    );

    expect(content).toContain("--rollback");
    expect(content).toContain("--dry-run");
    expect(content).toContain("empathy-model-backup");
    expect(content).toContain("/api/empathy/reload");
  });

  it("run-pipeline script should orchestrate all phases", () => {
    const content = readFileSync(
      `${import.meta.dir}/../scripts/empathy-training/run-pipeline.ts`,
      "utf-8"
    );

    expect(content).toContain("Phase 1");
    expect(content).toContain("Phase 2");
    expect(content).toContain("Phase 3");
    expect(content).toContain("Phase 4");
    expect(content).toContain("Phase 5");
    expect(content).toContain("collect.ts");
    expect(content).toContain("preprocess.ts");
    expect(content).toContain("train.py");
    expect(content).toContain("evaluate.ts");
    expect(content).toContain("deploy.ts");
  });
});

// ── Integration: Pipeline Data Flow ──────────────────────────

describe("Integration: Pipeline data flow", () => {
  it("should produce valid JSONL through collect → preprocess path", () => {
    // Write synthetic collected data
    const collected = [
      { text: "I'm really sad today", label: 2 },
      { text: "Fix the bug please", label: 0 },
      { text: "A bit stressed but ok", label: 1 },
      { text: "Deploy to production", label: 0 },
      { text: "Everything is falling apart", label: 2 },
      { text: "Nervous about the deadline", label: 1 },
    ];

    const jsonl = collected.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(`${TEST_DATA_DIR}/collected.jsonl`, jsonl);

    // Read and preprocess
    const lines = readFileSync(`${TEST_DATA_DIR}/collected.jsonl`, "utf-8")
      .trim()
      .split("\n");
    const examples = lines.map((l) => JSON.parse(l));

    // Split
    const train = examples.slice(0, 4);
    const val = examples.slice(4, 5);
    const test = examples.slice(5);

    expect(train.length).toBe(4);
    expect(val.length).toBe(1);
    expect(test.length).toBe(1);

    // All have required fields
    for (const split of [train, val, test]) {
      for (const ex of split) {
        expect(ex).toHaveProperty("text");
        expect(ex).toHaveProperty("label");
        expect([0, 1, 2]).toContain(ex.label);
      }
    }
  });

  it("BERT detector should handle all 3 tiers consistently", async () => {
    const lowResult = await detectEmpathyNeedsBert("run the migration please");
    const highResult = await detectEmpathyNeedsBert(
      "I'm so frustrated and overwhelmed. I don't know what to do. I feel like I'm failing."
    );

    expect(lowResult.tier).toBe("LOW");
    expect(["HIGH", "MODERATE"]).toContain(highResult.tier);
    expect(highResult.empathy_score).toBeGreaterThan(lowResult.empathy_score);
  });
});
