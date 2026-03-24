#!/usr/bin/env bun
/**
 * Phase 2: Data Preprocessing — ELLIE-990
 *
 * Reads collected.jsonl, applies preprocessing, splits into train/val/test,
 * and writes HuggingFace-compatible JSONL files.
 *
 * Split: 70% train, 15% val, 15% test (stratified by label)
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

const DATA_DIR = `${import.meta.dir}/../../data/empathy-training`;
const INPUT_FILE = `${DATA_DIR}/collected.jsonl`;

interface Example {
  text: string;
  label: number;
}

// ── Preprocessing ────────────────────────────────────────────

function preprocess(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "")  // remove URLs
    .replace(/<[^>]+>/g, "")          // remove HTML tags
    .replace(/\s+/g, " ")            // normalize whitespace (after removal)
    .trim()
    .slice(0, 512);                   // max length for BERT
}

// ── Stratified split ─────────────────────────────────────────

function stratifiedSplit(
  examples: Example[],
  trainRatio: number,
  valRatio: number
): { train: Example[]; val: Example[]; test: Example[] } {
  // Group by label
  const groups: Record<number, Example[]> = {};
  for (const ex of examples) {
    (groups[ex.label] ??= []).push(ex);
  }

  const train: Example[] = [];
  const val: Example[] = [];
  const test: Example[] = [];

  for (const label of Object.keys(groups).map(Number)) {
    const group = groups[label];
    // Shuffle
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [group[i], group[j]] = [group[j], group[i]];
    }

    const trainEnd = Math.floor(group.length * trainRatio);
    const valEnd = trainEnd + Math.floor(group.length * valRatio);

    train.push(...group.slice(0, trainEnd));
    val.push(...group.slice(trainEnd, valEnd));
    test.push(...group.slice(valEnd));
  }

  return { train, val, test };
}

// ── Main ─────────────────────────────────────────────────────

function main() {
  console.log("\nPhase 2: Data Preprocessing\n");

  if (!existsSync(INPUT_FILE)) {
    console.error(`Input file not found: ${INPUT_FILE}`);
    console.error("Run Phase 1 (collect.ts) first.");
    process.exit(1);
  }

  // Read
  const lines = readFileSync(INPUT_FILE, "utf-8").trim().split("\n");
  const examples: Example[] = lines.map((line) => {
    const parsed = JSON.parse(line);
    return {
      text: preprocess(parsed.text),
      label: parsed.label,
    };
  }).filter((ex) => ex.text.length >= 2); // drop empty after preprocessing

  console.log(`Loaded ${examples.length} examples`);

  // Split
  const { train, val, test } = stratifiedSplit(examples, 0.70, 0.15);

  // Write splits
  const writeJsonl = (path: string, data: Example[]) => {
    writeFileSync(path, data.map((ex) => JSON.stringify(ex)).join("\n") + "\n");
  };

  writeJsonl(`${DATA_DIR}/train.jsonl`, train);
  writeJsonl(`${DATA_DIR}/val.jsonl`, val);
  writeJsonl(`${DATA_DIR}/test.jsonl`, test);

  // Distribution
  const dist = (data: Example[]) => {
    const d = { 0: 0, 1: 0, 2: 0 };
    for (const ex of data) d[ex.label as 0 | 1 | 2]++;
    return d;
  };

  console.log(`\nSplit: ${train.length} train / ${val.length} val / ${test.length} test`);

  for (const [name, data] of [["train", train], ["val", val], ["test", test]] as const) {
    const d = dist(data as Example[]);
    console.log(`  ${name}: LOW=${d[0]}, MOD=${d[1]}, HIGH=${d[2]}`);
  }

  console.log(`\nWritten to: ${DATA_DIR}/{train,val,test}.jsonl`);
}

main();
