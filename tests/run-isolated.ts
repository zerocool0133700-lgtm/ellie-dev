#!/usr/bin/env bun
/**
 * Isolated Test Runner — ELLIE-577
 *
 * Runs each test file in its own `bun test` subprocess to prevent
 * mock.module() contamination between files. Bun's mock.module() is
 * process-global, so mocks from one file bleed into others when all
 * files run in a single process.
 *
 * Usage:
 *   bun tests/run-isolated.ts              # run all test files
 *   bun tests/run-isolated.ts prompt plane  # run files matching patterns
 */

import { Glob } from "bun";

const MAX_CONCURRENCY = Number(process.env.TEST_CONCURRENCY) || 8;
const patterns = process.argv.slice(2);

// Find all test files
const glob = new Glob("tests/**/*.test.ts");
let files = [...glob.scanSync({ cwd: process.cwd() })].sort();

// Filter by patterns if provided
if (patterns.length > 0) {
  files = files.filter(f => patterns.some(p => f.includes(p)));
}

console.log(`Running ${files.length} test files with process isolation (concurrency: ${MAX_CONCURRENCY})\n`);

interface TestResult {
  file: string;
  passed: boolean;
  pass: number;
  fail: number;
  error: number;
  duration: number;
  output: string;
}

const results: TestResult[] = [];
let running = 0;
let index = 0;

async function runFile(file: string): Promise<TestResult> {
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

  // Parse results from Bun's summary line (anchored to line start to avoid matching test names)
  const passMatch = output.match(/^\s*(\d+) pass$/m);
  const failMatch = output.match(/^\s*(\d+) fail$/m);
  const errorMatch = output.match(/^\s*(\d+) error/m);

  return {
    file,
    passed: exitCode === 0,
    pass: passMatch ? parseInt(passMatch[1]) : 0,
    fail: failMatch ? parseInt(failMatch[1]) : 0,
    error: errorMatch ? parseInt(errorMatch[1]) : 0,
    duration,
    output,
  };
}

async function runAll(): Promise<void> {
  const queue = [...files];
  const promises: Promise<void>[] = [];

  function next(): Promise<void> | undefined {
    const file = queue.shift();
    if (!file) return undefined;

    return runFile(file).then(result => {
      results.push(result);
      const icon = result.passed ? "✓" : "✗";
      const failInfo = result.fail > 0 ? ` (${result.fail} fail)` : "";
      const errorInfo = result.error > 0 ? ` (${result.error} errors)` : "";
      const time = `${result.duration}ms`;
      process.stdout.write(`${icon} ${result.file} [${time}]${failInfo}${errorInfo}\n`);

      // Start next file
      const n = next();
      if (n) return n;
    });
  }

  // Start up to MAX_CONCURRENCY files
  for (let i = 0; i < Math.min(MAX_CONCURRENCY, queue.length); i++) {
    const p = next();
    if (p) promises.push(p);
  }

  await Promise.all(promises);
}

const totalStart = Date.now();
await runAll();
const totalDuration = Date.now() - totalStart;

// Summary
const totalPass = results.reduce((s, r) => s + r.pass, 0);
const totalFail = results.reduce((s, r) => s + r.fail, 0);
const totalError = results.reduce((s, r) => s + r.error, 0);
const failedFiles = results.filter(r => !r.passed);

console.log(`\n${"─".repeat(60)}`);
console.log(`${totalPass} pass, ${totalFail} fail, ${totalError} errors`);
console.log(`${results.length} files in ${(totalDuration / 1000).toFixed(1)}s`);

if (failedFiles.length > 0) {
  console.log(`\n${failedFiles.length} FAILED FILES:`);
  for (const f of failedFiles) {
    console.log(`  ✗ ${f.file} (${f.fail} fail, ${f.error} errors)`);
  }

  // Show failure details
  if (process.env.VERBOSE || failedFiles.length <= 5) {
    for (const f of failedFiles) {
      console.log(`\n${"═".repeat(60)}`);
      console.log(`FAILURE: ${f.file}`);
      console.log("═".repeat(60));
      // Show only the error lines
      const lines = f.output.split("\n");
      const errorLines = lines.filter(l =>
        l.includes("(fail)") || l.includes("error:") || l.includes("Expected") || l.includes("Received")
      );
      console.log(errorLines.join("\n"));
    }
  }

  process.exit(1);
} else {
  console.log("\nAll tests passed!");
  process.exit(0);
}
