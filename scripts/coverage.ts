#!/usr/bin/env bun
/**
 * Code Coverage Runner
 *
 * Runs each test file in an isolated subprocess with Bun's native coverage,
 * merges the lcov output, and generates a summary report.
 *
 * Bun doesn't support NODE_V8_COVERAGE (which c8 relies on), so we use
 * Bun's built-in --coverage --coverage-reporter=lcov and merge the results.
 *
 * Usage:
 *   bun scripts/coverage.ts              # run all tests with coverage
 *   bun scripts/coverage.ts prompt plane  # run matching tests with coverage
 */

import { Glob } from "bun";
import { rmSync, mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

const MAX_CONCURRENCY = Number(process.env.TEST_CONCURRENCY) || 8;
const patterns = process.argv.slice(2);
const COVERAGE_DIR = join(process.cwd(), "coverage");
const PARTS_DIR = join(COVERAGE_DIR, "parts");

// Clean previous coverage
if (existsSync(COVERAGE_DIR)) {
  rmSync(COVERAGE_DIR, { recursive: true });
}
mkdirSync(PARTS_DIR, { recursive: true });

// Find all test files
const glob = new Glob("tests/**/*.test.ts");
let files = [...glob.scanSync({ cwd: process.cwd() })].sort();

if (patterns.length > 0) {
  files = files.filter(f => patterns.some(p => f.includes(p)));
}

console.log(`Running ${files.length} test files with coverage (concurrency: ${MAX_CONCURRENCY})\n`);

interface TestResult {
  file: string;
  passed: boolean;
  pass: number;
  fail: number;
  duration: number;
}

const results: TestResult[] = [];

async function runFile(file: string, index: number): Promise<TestResult> {
  const partDir = join(PARTS_DIR, `part-${index}`);
  mkdirSync(partDir, { recursive: true });

  const start = Date.now();
  const proc = Bun.spawn([
    "bun", "test",
    "--preload", "./tests/helpers/coverage-preload.ts",
    "--timeout", "30000",
    "--coverage",
    "--coverage-reporter=lcov",
    `--coverage-dir=${partDir}`,
    file,
  ], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  const output = stdout + stderr;
  const duration = Date.now() - start;

  const passMatch = output.match(/^\s*(\d+) pass$/m);
  const failMatch = output.match(/^\s*(\d+) fail$/m);

  return {
    file,
    passed: exitCode === 0,
    pass: passMatch ? parseInt(passMatch[1]) : 0,
    fail: failMatch ? parseInt(failMatch[1]) : 0,
    duration,
  };
}

async function runAll(): Promise<void> {
  const queue = files.map((f, i) => ({ file: f, index: i }));
  const promises: Promise<void>[] = [];

  function next(): Promise<void> | undefined {
    const item = queue.shift();
    if (!item) return undefined;

    return runFile(item.file, item.index).then(result => {
      results.push(result);
      const icon = result.passed ? "✓" : "✗";
      const failInfo = result.fail > 0 ? ` (${result.fail} fail)` : "";
      process.stdout.write(`${icon} ${result.file} [${result.duration}ms]${failInfo}\n`);
      const n = next();
      if (n) return n;
    });
  }

  for (let i = 0; i < Math.min(MAX_CONCURRENCY, queue.length); i++) {
    const p = next();
    if (p) promises.push(p);
  }

  await Promise.all(promises);
}

// --- LCOV Parsing & Merging ---

interface FileCoverage {
  lines: Map<number, number>;       // line -> hit count
  functions: Map<string, number>;   // funcName -> hit count
  branches: Map<string, number>;    // branchKey -> hit count
}

function parseLcov(content: string): Map<string, FileCoverage> {
  const files = new Map<string, FileCoverage>();
  let current: FileCoverage | null = null;
  let currentFile = "";

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("SF:")) {
      currentFile = trimmed.slice(3);
      current = files.get(currentFile) || {
        lines: new Map(),
        functions: new Map(),
        branches: new Map(),
      };
      files.set(currentFile, current);
    } else if (trimmed.startsWith("DA:") && current) {
      const parts = trimmed.slice(3).split(",");
      const lineNo = parseInt(parts[0]);
      const hits = parseInt(parts[1]);
      current.lines.set(lineNo, (current.lines.get(lineNo) || 0) + hits);
    } else if (trimmed.startsWith("FNDA:") && current) {
      const parts = trimmed.slice(5).split(",");
      const hits = parseInt(parts[0]);
      const name = parts.slice(1).join(",");
      current.functions.set(name, (current.functions.get(name) || 0) + hits);
    } else if (trimmed.startsWith("BRDA:") && current) {
      const parts = trimmed.slice(5).split(",");
      const key = `${parts[0]},${parts[1]},${parts[2]}`;
      const hits = parts[3] === "-" ? 0 : parseInt(parts[3]);
      current.branches.set(key, (current.branches.get(key) || 0) + hits);
    }
  }
  return files;
}

function mergeLcovMaps(maps: Map<string, FileCoverage>[]): Map<string, FileCoverage> {
  const merged = new Map<string, FileCoverage>();

  for (const map of maps) {
    for (const [file, cov] of map) {
      const existing = merged.get(file) || {
        lines: new Map(),
        functions: new Map(),
        branches: new Map(),
      };

      for (const [line, hits] of cov.lines) {
        existing.lines.set(line, (existing.lines.get(line) || 0) + hits);
      }
      for (const [fn, hits] of cov.functions) {
        existing.functions.set(fn, (existing.functions.get(fn) || 0) + hits);
      }
      for (const [br, hits] of cov.branches) {
        existing.branches.set(br, (existing.branches.get(br) || 0) + hits);
      }

      merged.set(file, existing);
    }
  }
  return merged;
}

function toMergedLcov(merged: Map<string, FileCoverage>): string {
  const lines: string[] = [];

  for (const [file, cov] of [...merged].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`SF:${file}`);

    // Functions
    for (const [name] of cov.functions) {
      lines.push(`FN:0,${name}`);
    }
    lines.push(`FNF:${cov.functions.size}`);
    let fnHit = 0;
    for (const [name, hits] of cov.functions) {
      lines.push(`FNDA:${hits},${name}`);
      if (hits > 0) fnHit++;
    }
    lines.push(`FNH:${fnHit}`);

    // Branches
    for (const [key, hits] of cov.branches) {
      lines.push(`BRDA:${key},${hits}`);
    }
    let brTotal = cov.branches.size;
    let brHit = 0;
    for (const hits of cov.branches.values()) {
      if (hits > 0) brHit++;
    }
    lines.push(`BRF:${brTotal}`);
    lines.push(`BRH:${brHit}`);

    // Lines
    for (const [line, hits] of [...cov.lines].sort((a, b) => a[0] - b[0])) {
      lines.push(`DA:${line},${hits}`);
    }
    lines.push(`LF:${cov.lines.size}`);
    let lhit = 0;
    for (const hits of cov.lines.values()) {
      if (hits > 0) lhit++;
    }
    lines.push(`LH:${lhit}`);

    lines.push("end_of_record");
  }
  return lines.join("\n") + "\n";
}

// --- Run ---

const totalStart = Date.now();
await runAll();
const totalDuration = Date.now() - totalStart;

// Merge lcov files
console.log("\nMerging coverage data...");
const lcovMaps: Map<string, FileCoverage>[] = [];

for (const dir of readdirSync(PARTS_DIR)) {
  const lcovPath = join(PARTS_DIR, dir, "lcov.info");
  if (existsSync(lcovPath)) {
    const content = readFileSync(lcovPath, "utf-8");
    if (content.trim()) {
      lcovMaps.push(parseLcov(content));
    }
  }
}

const merged = mergeLcovMaps(lcovMaps);
const mergedLcov = toMergedLcov(merged);
writeFileSync(join(COVERAGE_DIR, "lcov.info"), mergedLcov);

// Clean up parts
rmSync(PARTS_DIR, { recursive: true });

// Generate text summary — filter to src/ files (relative paths from lcov)
const srcFiles = [...merged].filter(([f]) => f.startsWith("src/"));

let totalLines = 0;
let coveredLines = 0;
let totalFunctions = 0;
let coveredFunctions = 0;
let totalBranches = 0;
let coveredBranches = 0;

interface DirSummary {
  lines: number;
  coveredLines: number;
  functions: number;
  coveredFunctions: number;
  files: number;
}

const dirSummaries = new Map<string, DirSummary>();

for (const [file, cov] of srcFiles) {
  const rel = file.slice("src/".length);
  const dir = rel.includes("/") ? rel.split("/").slice(0, -1).join("/") : ".";

  const ds = dirSummaries.get(dir) || { lines: 0, coveredLines: 0, functions: 0, coveredFunctions: 0, files: 0 };
  ds.files++;
  ds.lines += cov.lines.size;
  ds.functions += cov.functions.size;

  for (const hits of cov.lines.values()) {
    if (hits > 0) ds.coveredLines++;
  }
  for (const hits of cov.functions.values()) {
    if (hits > 0) ds.coveredFunctions++;
  }

  dirSummaries.set(dir, ds);
}

for (const ds of dirSummaries.values()) {
  totalLines += ds.lines;
  coveredLines += ds.coveredLines;
  totalFunctions += ds.functions;
  coveredFunctions += ds.coveredFunctions;
}

for (const [file, cov] of srcFiles) {
  for (const hits of cov.branches.values()) {
    totalBranches++;
    if (hits > 0) coveredBranches++;
  }
}

function pct(covered: number, total: number): string {
  if (total === 0) return "N/A";
  return ((covered / total) * 100).toFixed(1) + "%";
}

function pad(s: string, len: number): string {
  return s.padEnd(len);
}

console.log(`\n${"─".repeat(80)}`);
console.log("CODE COVERAGE SUMMARY");
console.log("─".repeat(80));

// Test results
const totalPass = results.reduce((s, r) => s + r.pass, 0);
const totalFail = results.reduce((s, r) => s + r.fail, 0);
console.log(`Tests: ${totalPass} pass, ${totalFail} fail (${results.length} files in ${(totalDuration / 1000).toFixed(1)}s)\n`);

// Directory breakdown
console.log(pad("Directory", 40) + pad("Lines", 22) + pad("Functions", 22) + "Files");
console.log("─".repeat(90));

for (const [dir, ds] of [...dirSummaries].sort((a, b) => a[0].localeCompare(b[0]))) {
  const linePct = pct(ds.coveredLines, ds.lines);
  const fnPct = pct(ds.coveredFunctions, ds.functions);
  const dirLabel = dir === "." ? "src/" : `src/${dir}/`;
  console.log(
    pad(dirLabel, 40) +
    pad(`${linePct} (${ds.coveredLines}/${ds.lines})`, 22) +
    pad(`${fnPct} (${ds.coveredFunctions}/${ds.functions})`, 22) +
    ds.files
  );
}

console.log("─".repeat(90));
console.log(
  pad("TOTAL", 40) +
  pad(`${pct(coveredLines, totalLines)} (${coveredLines}/${totalLines})`, 22) +
  pad(`${pct(coveredFunctions, totalFunctions)} (${coveredFunctions}/${totalFunctions})`, 22) +
  srcFiles.length + " files"
);

console.log(`\nBranches: ${pct(coveredBranches, totalBranches)} (${coveredBranches}/${totalBranches})`);
console.log(`\nReports saved to: coverage/`);
console.log(`  coverage/lcov.info    — lcov format (CI integration)`);

if (totalFail > 0) {
  const failedFiles = results.filter(r => !r.passed);
  console.log(`\n${failedFiles.length} FAILED FILES:`);
  for (const f of failedFiles) {
    console.log(`  ✗ ${f.file} (${f.fail} fail)`);
  }
  process.exit(1);
}

process.exit(0);
