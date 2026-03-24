#!/usr/bin/env bun
/**
 * Phase 5: Model Deployment & Hot-Swap — ELLIE-990
 *
 * Deploys a fine-tuned ONNX empathy model to the production detector.
 * Supports hot-swap without relay restart.
 *
 * Usage:
 *   bun run scripts/empathy-training/deploy.ts --model-path data/empathy-training/model/onnx
 *   bun run scripts/empathy-training/deploy.ts --rollback
 */

import { existsSync, cpSync, mkdirSync, renameSync, rmSync } from "fs";

const SCRIPT_DIR = import.meta.dir;
const PROJECT_ROOT = `${SCRIPT_DIR}/../..`;
const MODEL_DEPLOY_DIR = `${PROJECT_ROOT}/data/empathy-model`;
const BACKUP_DIR = `${PROJECT_ROOT}/data/empathy-model-backup`;

function parseArgs(): { modelPath?: string; rollback: boolean; dryRun: boolean } {
  const args = process.argv.slice(2);
  let modelPath: string | undefined;
  let rollback = false;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model-path" && args[i + 1]) modelPath = args[++i];
    if (args[i] === "--rollback") rollback = true;
    if (args[i] === "--dry-run") dryRun = true;
  }

  return { modelPath, rollback, dryRun };
}

async function deploy(modelPath: string, dryRun: boolean) {
  console.log("\nPhase 5: Deploy Fine-Tuned Model\n");

  // Validate source
  const configPath = `${modelPath}/config.json`;
  if (!existsSync(configPath)) {
    console.error(`Error: No config.json found at ${modelPath}`);
    console.error("Expected an ONNX model directory with config.json + model.onnx + tokenizer files");
    process.exit(1);
  }

  console.log(`Source model: ${modelPath}`);
  console.log(`Deploy target: ${MODEL_DEPLOY_DIR}`);

  if (dryRun) {
    console.log("\n[DRY RUN] Would deploy model. Exiting.");
    return;
  }

  // Backup current model (if exists)
  if (existsSync(MODEL_DEPLOY_DIR)) {
    console.log(`Backing up current model to: ${BACKUP_DIR}`);
    if (existsSync(BACKUP_DIR)) rmSync(BACKUP_DIR, { recursive: true });
    renameSync(MODEL_DEPLOY_DIR, BACKUP_DIR);
  }

  // Copy new model
  mkdirSync(MODEL_DEPLOY_DIR, { recursive: true });
  cpSync(modelPath, MODEL_DEPLOY_DIR, { recursive: true });
  console.log("Model deployed.");

  // Hot-swap: notify relay via API
  console.log("\nNotifying relay to reload model...");
  try {
    const response = await fetch("http://localhost:3001/api/empathy/reload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    if (response.ok) {
      console.log("Relay acknowledged model reload.");
    } else {
      console.log(`Relay returned ${response.status} — model will load on next restart.`);
    }
  } catch {
    console.log("Relay not reachable — model will load on next restart.");
  }

  console.log("\nDeployment complete.");
  console.log("Use --rollback to revert to the previous model.");
}

async function rollback(dryRun: boolean) {
  console.log("\nRolling back to previous model...\n");

  if (!existsSync(BACKUP_DIR)) {
    console.error("No backup found. Nothing to roll back to.");
    process.exit(1);
  }

  if (dryRun) {
    console.log("[DRY RUN] Would rollback. Exiting.");
    return;
  }

  // Remove current and restore backup
  if (existsSync(MODEL_DEPLOY_DIR)) rmSync(MODEL_DEPLOY_DIR, { recursive: true });
  renameSync(BACKUP_DIR, MODEL_DEPLOY_DIR);

  console.log("Rolled back to previous model.");

  // Notify relay
  try {
    await fetch("http://localhost:3001/api/empathy/reload", { method: "POST" });
    console.log("Relay notified.");
  } catch {
    console.log("Relay not reachable — model will load on next restart.");
  }
}

// ── Main ─────────────────────────────────────────────────────

const args = parseArgs();

if (args.rollback) {
  rollback(args.dryRun);
} else if (args.modelPath) {
  deploy(args.modelPath, args.dryRun);
} else {
  console.log("Usage:");
  console.log("  bun run scripts/empathy-training/deploy.ts --model-path <path>");
  console.log("  bun run scripts/empathy-training/deploy.ts --rollback");
  console.log("  Add --dry-run to preview without changes");
}
