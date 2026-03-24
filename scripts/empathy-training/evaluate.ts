#!/usr/bin/env bun
/**
 * Phase 4: Evaluation — ELLIE-990
 *
 * Evaluates both the production detector and a fine-tuned model against
 * the held-out test set. Reports precision/recall/F1 per tier.
 *
 * Usage:
 *   bun run scripts/empathy-training/evaluate.ts
 *   bun run scripts/empathy-training/evaluate.ts --model-path data/empathy-training/model/onnx
 */

import { readFileSync, existsSync } from "fs";
import { detectEmpathyNeedsBert, _resetModelState } from "../../src/empathy-detector-bert.ts";
import { detectEmpathyNeeds } from "../../src/empathy-detector.ts";

const DATA_DIR = `${import.meta.dir}/../../data/empathy-training`;
const TEST_FILE = `${DATA_DIR}/test.jsonl`;

interface Example {
  text: string;
  label: number; // 0=LOW, 1=MODERATE, 2=HIGH
}

const LABEL_NAMES: Record<number, string> = { 0: "LOW", 1: "MODERATE", 2: "HIGH" };

// ── Metrics ──────────────────────────────────────────────────

interface PerClassMetrics {
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

interface EvalResult {
  accuracy: number;
  per_class: Record<string, PerClassMetrics>;
  confusion_matrix: number[][];
  predictions: { text: string; predicted: number; actual: number }[];
}

function evaluate(
  predictions: number[],
  actuals: number[],
  texts: string[]
): EvalResult {
  const numClasses = 3;
  const confusion = Array.from({ length: numClasses }, () => Array(numClasses).fill(0));

  let correct = 0;
  const preds: EvalResult["predictions"] = [];

  for (let i = 0; i < predictions.length; i++) {
    confusion[actuals[i]][predictions[i]]++;
    if (predictions[i] === actuals[i]) correct++;
    preds.push({ text: texts[i], predicted: predictions[i], actual: actuals[i] });
  }

  const per_class: Record<string, PerClassMetrics> = {};

  for (let c = 0; c < numClasses; c++) {
    const tp = confusion[c][c];
    const fp = confusion.reduce((sum, row, i) => sum + (i !== c ? row[c] : 0), 0);
    const fn = confusion[c].reduce((sum, val, j) => sum + (j !== c ? val : 0), 0);
    const support = confusion[c].reduce((a, b) => a + b, 0);

    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    per_class[LABEL_NAMES[c]] = { precision, recall, f1, support };
  }

  return {
    accuracy: correct / predictions.length,
    per_class,
    confusion_matrix: confusion,
    predictions: preds,
  };
}

// ── Tier from score ──────────────────────────────────────────

function tierToLabel(tier: string): number {
  if (tier === "HIGH") return 2;
  if (tier === "MODERATE") return 1;
  return 0;
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log("\nPhase 4: Evaluation\n");

  if (!existsSync(TEST_FILE)) {
    console.error(`Test file not found: ${TEST_FILE}`);
    console.error("Run Phase 1 + 2 first.");
    process.exit(1);
  }

  const lines = readFileSync(TEST_FILE, "utf-8").trim().split("\n");
  const examples: Example[] = lines.map((l) => JSON.parse(l));
  console.log(`Loaded ${examples.length} test examples\n`);

  // ── Evaluate keyword detector ──────────────────────────────

  console.log("Evaluating keyword/VADER detector...");
  const keywordPreds: number[] = [];
  for (const ex of examples) {
    const result = detectEmpathyNeeds(ex.text);
    keywordPreds.push(tierToLabel(result.tier));
  }

  const keywordResult = evaluate(
    keywordPreds,
    examples.map((e) => e.label),
    examples.map((e) => e.text)
  );
  printResult("Keyword/VADER", keywordResult);

  // ── Evaluate BERT hybrid detector ──────────────────────────

  console.log("\nEvaluating BERT+keyword hybrid detector...");
  const bertPreds: number[] = [];
  for (const ex of examples) {
    const result = await detectEmpathyNeedsBert(ex.text);
    bertPreds.push(tierToLabel(result.tier));
  }

  const bertResult = evaluate(
    bertPreds,
    examples.map((e) => e.label),
    examples.map((e) => e.text)
  );
  printResult("BERT+Keyword Hybrid", bertResult);

  // ── Show misclassifications ────────────────────────────────

  console.log("\n--- Misclassifications (BERT) ---\n");
  const misses = bertResult.predictions.filter((p) => p.predicted !== p.actual);
  for (const miss of misses.slice(0, 15)) {
    const pred = LABEL_NAMES[miss.predicted];
    const actual = LABEL_NAMES[miss.actual];
    const text = miss.text.length > 80 ? miss.text.slice(0, 80) + "..." : miss.text;
    console.log(`  [${actual} -> ${pred}] ${text}`);
  }
  if (misses.length > 15) {
    console.log(`  ... and ${misses.length - 15} more`);
  }

  // ── Comparison ─────────────────────────────────────────────

  console.log("\n--- Comparison ---\n");
  console.log(`  Keyword accuracy: ${(keywordResult.accuracy * 100).toFixed(1)}%`);
  console.log(`  BERT accuracy:    ${(bertResult.accuracy * 100).toFixed(1)}%`);
  const improvement = bertResult.accuracy - keywordResult.accuracy;
  console.log(`  Improvement:      ${improvement >= 0 ? "+" : ""}${(improvement * 100).toFixed(1)}%`);
}

function printResult(name: string, result: EvalResult) {
  console.log(`\n  === ${name} ===`);
  console.log(`  Accuracy: ${(result.accuracy * 100).toFixed(1)}%\n`);
  console.log("  Class      Precision  Recall  F1     Support");
  console.log("  " + "-".repeat(50));
  for (const [cls, m] of Object.entries(result.per_class)) {
    console.log(
      `  ${cls.padEnd(10)} ${(m.precision * 100).toFixed(1).padStart(8)}%  ${(m.recall * 100).toFixed(1).padStart(5)}%  ${(m.f1 * 100).toFixed(1).padStart(5)}%  ${String(m.support).padStart(5)}`
    );
  }
  console.log("\n  Confusion Matrix (rows=actual, cols=predicted):");
  console.log("           LOW  MOD  HIGH");
  for (let i = 0; i < 3; i++) {
    const row = result.confusion_matrix[i].map((v) => String(v).padStart(4)).join(" ");
    console.log(`  ${LABEL_NAMES[i].padEnd(8)} ${row}`);
  }
}

main().catch(console.error);
