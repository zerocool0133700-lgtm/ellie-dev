#!/usr/bin/env bun
/**
 * Run the full 5-phase empathy training pipeline — ELLIE-990
 *
 * Usage:
 *   bun run scripts/empathy-training/run-pipeline.ts           # Phase 1-2 + 4 (no training)
 *   bun run scripts/empathy-training/run-pipeline.ts --train   # Full pipeline including Python training
 *   bun run scripts/empathy-training/run-pipeline.ts --deploy  # Run all phases + deploy
 */

import { $ } from "bun";

const args = process.argv.slice(2);
const doTrain = args.includes("--train");
const doDeploy = args.includes("--deploy");

console.log("=== Empathy Training Pipeline ===\n");

// Phase 1: Collect
console.log("--- Phase 1: Collect ---");
await $`bun run scripts/empathy-training/collect.ts`;

// Phase 2: Preprocess
console.log("\n--- Phase 2: Preprocess ---");
await $`bun run scripts/empathy-training/preprocess.ts`;

// Phase 3: Train (optional — requires Python + PyTorch)
if (doTrain) {
  console.log("\n--- Phase 3: Train ---");
  await $`python3 scripts/empathy-training/train.py`;
} else {
  console.log("\n--- Phase 3: Train (skipped — pass --train to enable) ---");
}

// Phase 4: Evaluate
console.log("\n--- Phase 4: Evaluate ---");
await $`bun run scripts/empathy-training/evaluate.ts`;

// Phase 5: Deploy (optional)
if (doDeploy) {
  console.log("\n--- Phase 5: Deploy ---");
  await $`bun run scripts/empathy-training/deploy.ts --model-path data/empathy-training/model/onnx`;
} else {
  console.log("\n--- Phase 5: Deploy (skipped — pass --deploy to enable) ---");
}

console.log("\n=== Pipeline complete ===");
