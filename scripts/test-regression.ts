#!/usr/bin/env bun
/**
 * Regression Test Runner — ELLIE-502
 *
 * Runs the full test suite with process isolation and produces a structured
 * markdown report. Results are saved to the River vault so agents can query
 * historical test trends via QMD.
 *
 * Usage:
 *   bun scripts/test-regression.ts              # run all tests
 *   bun scripts/test-regression.ts --no-save    # run without saving to River
 *   bun scripts/test-regression.ts --verbose    # show failure details inline
 */

import { Glob } from "bun";
import { mkdir, writeFile } from "fs/promises";
import { dirname, join } from "path";

const MAX_CONCURRENCY = Number(process.env.TEST_CONCURRENCY) || 8;
const RIVER_VAULT = process.env.RIVER_VAULT || "/home/ellie/ellie-river/vault";
const args = process.argv.slice(2);
const noSave = args.includes("--no-save");
const verbose = args.includes("--verbose");

// ── Types ────────────────────────────────────────────────────────────

interface FileResult {
  file: string;
  passed: boolean;
  pass: number;
  fail: number;
  skip: number;
  error: number;
  duration: number;
  output: string;
}

interface RegressionReport {
  timestamp: string;
  totalFiles: number;
  totalPass: number;
  totalFail: number;
  totalSkip: number;
  totalError: number;
  totalDuration: number;
  passRate: string;
  fileResults: FileResult[];
  failedFiles: FileResult[];
}

// ── Test Runner ──────────────────────────────────────────────────────

async function runFile(file: string): Promise<FileResult> {
  const start = Date.now();
  const proc = Bun.spawn(["bun", "test", "--timeout", "30000", file], {
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

  // Parse Bun test summary lines (anchored to line start)
  const passMatch = output.match(/^\s*(\d+) pass$/m);
  const failMatch = output.match(/^\s*(\d+) fail$/m);
  const skipMatch = output.match(/^\s*(\d+) skip$/m);
  const errorMatch = output.match(/^\s*(\d+) error/m);

  return {
    file,
    passed: exitCode === 0,
    pass: passMatch ? parseInt(passMatch[1]) : 0,
    fail: failMatch ? parseInt(failMatch[1]) : 0,
    skip: skipMatch ? parseInt(skipMatch[1]) : 0,
    error: errorMatch ? parseInt(errorMatch[1]) : 0,
    duration,
    output,
  };
}

async function runAll(files: string[]): Promise<FileResult[]> {
  const results: FileResult[] = [];
  const queue = [...files];

  function next(): Promise<void> | undefined {
    const file = queue.shift();
    if (!file) return undefined;

    return runFile(file).then(result => {
      results.push(result);
      const icon = result.passed ? "✓" : "✗";
      const failInfo = result.fail > 0 ? ` (${result.fail} fail)` : "";
      const errorInfo = result.error > 0 ? ` (${result.error} errors)` : "";
      const skipInfo = result.skip > 0 ? ` (${result.skip} skip)` : "";
      process.stdout.write(`${icon} ${result.file} [${result.duration}ms]${failInfo}${errorInfo}${skipInfo}\n`);

      const n = next();
      if (n) return n;
    });
  }

  const promises: Promise<void>[] = [];
  for (let i = 0; i < Math.min(MAX_CONCURRENCY, queue.length); i++) {
    const p = next();
    if (p) promises.push(p);
  }
  await Promise.all(promises);

  // Sort by file path for consistent output
  return results.sort((a, b) => a.file.localeCompare(b.file));
}

// ── Report Generation ────────────────────────────────────────────────

function buildReport(results: FileResult[], totalDuration: number): RegressionReport {
  const totalPass = results.reduce((s, r) => s + r.pass, 0);
  const totalFail = results.reduce((s, r) => s + r.fail, 0);
  const totalSkip = results.reduce((s, r) => s + r.skip, 0);
  const totalError = results.reduce((s, r) => s + r.error, 0);
  const totalTests = totalPass + totalFail + totalError;
  const passRate = totalTests > 0 ? ((totalPass / totalTests) * 100).toFixed(1) : "0.0";

  return {
    timestamp: new Date().toISOString(),
    totalFiles: results.length,
    totalPass,
    totalFail,
    totalSkip,
    totalError,
    totalDuration,
    passRate: `${passRate}%`,
    fileResults: results,
    failedFiles: results.filter(r => !r.passed),
  };
}

function reportToMarkdown(report: RegressionReport): string {
  const date = report.timestamp.split("T")[0];
  const time = report.timestamp.split("T")[1].split(".")[0];
  const durationSec = (report.totalDuration / 1000).toFixed(1);

  const lines: string[] = [
    `# Regression Test Report — ${date}`,
    "",
    `**Run at:** ${date} ${time} UTC`,
    `**Duration:** ${durationSec}s`,
    `**Pass rate:** ${report.passRate}`,
    "",
    "## Summary",
    "",
    "| Metric | Count |",
    "|--------|-------|",
    `| Files | ${report.totalFiles} |`,
    `| Pass | ${report.totalPass} |`,
    `| Fail | ${report.totalFail} |`,
    `| Skip | ${report.totalSkip} |`,
    `| Error | ${report.totalError} |`,
    `| Duration | ${durationSec}s |`,
    "",
  ];

  // Failed files section
  if (report.failedFiles.length > 0) {
    lines.push("## Failed Files", "");
    for (const f of report.failedFiles) {
      lines.push(`- **${f.file}** — ${f.fail} fail, ${f.error} errors (${f.duration}ms)`);
    }
    lines.push("");
  }

  // Per-file breakdown (top 20 slowest first, then rest)
  lines.push("## Per-File Breakdown", "");
  lines.push("| Status | File | Pass | Fail | Skip | Err | Duration |");
  lines.push("|--------|------|------|------|------|-----|----------|");

  const sorted = [...report.fileResults].sort((a, b) => b.duration - a.duration);
  for (const r of sorted) {
    const status = r.passed ? "PASS" : "FAIL";
    const shortFile = r.file.replace("tests/", "");
    lines.push(`| ${status} | ${shortFile} | ${r.pass} | ${r.fail} | ${r.skip} | ${r.error} | ${r.duration}ms |`);
  }
  lines.push("");

  // Slowest files
  const top10 = sorted.slice(0, 10);
  lines.push("## Slowest Files", "");
  for (const r of top10) {
    lines.push(`- ${r.file} — ${r.duration}ms`);
  }
  lines.push("");

  return lines.join("\n");
}

// ── River Vault Write ────────────────────────────────────────────────

function buildFrontmatter(report: RegressionReport): string {
  const date = report.timestamp.split("T")[0];
  const lines = [
    "---",
    `type: regression-report`,
    `date: ${date}`,
    `pass_rate: "${report.passRate}"`,
    `total_pass: ${report.totalPass}`,
    `total_fail: ${report.totalFail}`,
    `total_skip: ${report.totalSkip}`,
    `total_error: ${report.totalError}`,
    `total_files: ${report.totalFiles}`,
    `duration_ms: ${report.totalDuration}`,
    "---",
    "",
  ];
  return lines.join("\n");
}

async function saveToRiver(markdown: string, report: RegressionReport): Promise<boolean> {
  const date = report.timestamp.split("T")[0];
  const relPath = `benchmarks/regression-${date}.md`;
  const fullPath = join(RIVER_VAULT, relPath);
  const content = buildFrontmatter(report) + markdown;

  try {
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
    console.log(`Saved to River vault: ${relPath}`);

    // Trigger QMD reindex
    const proc = Bun.spawn(["qmd", "update"], {
      cwd: RIVER_VAULT,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    const qmdOut = await new Response(proc.stdout).text();
    const indexed = qmdOut.includes("1 new") || qmdOut.includes("1 updated");
    console.log(`QMD reindex: ${indexed ? "indexed" : "already up to date"}`);
    return true;
  } catch (err) {
    console.error(`River write error: ${err}`);
    return false;
  }
}

// ── Main ─────────────────────────────────────────────────────────────

const glob = new Glob("tests/**/*.test.ts");
const files = [...glob.scanSync({ cwd: process.cwd() })].sort();

console.log(`Regression test run — ${files.length} test files (concurrency: ${MAX_CONCURRENCY})\n`);

const totalStart = Date.now();
const results = await runAll(files);
const totalDuration = Date.now() - totalStart;

const report = buildReport(results, totalDuration);
const markdown = reportToMarkdown(report);

// Console summary
console.log(`\n${"─".repeat(60)}`);
console.log(`${report.totalPass} pass, ${report.totalFail} fail, ${report.totalSkip} skip, ${report.totalError} errors`);
console.log(`${report.totalFiles} files in ${(totalDuration / 1000).toFixed(1)}s — pass rate: ${report.passRate}`);

if (report.failedFiles.length > 0) {
  console.log(`\n${report.failedFiles.length} FAILED FILES:`);
  for (const f of report.failedFiles) {
    console.log(`  ✗ ${f.file} (${f.fail} fail, ${f.error} errors)`);
  }

  if (verbose) {
    for (const f of report.failedFiles) {
      console.log(`\n${"═".repeat(60)}`);
      console.log(`FAILURE: ${f.file}`);
      console.log("═".repeat(60));
      const lines = f.output.split("\n");
      const errorLines = lines.filter(l =>
        l.includes("(fail)") || l.includes("error:") || l.includes("Expected") || l.includes("Received")
      );
      console.log(errorLines.join("\n"));
    }
  }
}

// Save to River vault
if (!noSave) {
  console.log("");
  await saveToRiver(markdown, report);
}

console.log("");
process.exit(report.totalFail > 0 || report.totalError > 0 ? 1 : 0);
