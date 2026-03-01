#!/usr/bin/env bun
/**
 * ELLIE-369: Behavioral Verification
 *
 * Dispatches a standard test prompt to each creature type and verifies
 * that the archetype produces observably different behavior.
 *
 * Uses the Anthropic API directly with Haiku for cost efficiency.
 *
 * Usage:
 *   bun run scripts/verify-behavior-369.ts [--creature dev] [--verbose]
 *   bun run scripts/verify-behavior-369.ts --show-trends
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFile, readdir, writeFile } from "fs/promises";
import { join } from "path";
import { detectMode, getModeSectionPriorities, getModeTokenBudget } from "../src/context-mode.ts";

// ── Config ──────────────────────────────────────────────────

const ARCHETYPES_DIR = join(import.meta.dir, "../config/archetypes");
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 600;
const RESULTS_DIR = "/tmp/ellie-369-results";
const TRENDS_FILE = join(import.meta.dir, "verify-trends.json");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

// ── Test prompt ─────────────────────────────────────────────
// Deliberately ambiguous: could trigger implementation, analysis,
// critique, monitoring, triage, etc. depending on creature type.

const TEST_PROMPT = `ELLIE-999: The login page is slow. Users report 5-second load times on the dashboard. The backend API responds in 200ms but the frontend takes 4.8s to render. What should we do?`;

// ── Expected behavioral signals per creature ────────────────

interface BehaviorCheck {
  creature: string;
  mustInclude: string[];      // At least one of these phrases/patterns must appear
  mustExclude: string[];      // None of these should appear
  description: string;        // What we expect
  maxLengthVsControl?: number; // Max ratio of response length vs control (e.g. 0.5 = half)
}

const CHECKS: BehaviorCheck[] = [
  {
    creature: "dev",
    mustInclude: ["file", "component", "bundle", "render", "lazy", "code", "implement", "fix", "diff", "profil"],
    mustExclude: ["I recommend we form a committee", "let me monitor"],
    description: "Depth-first: jumps to implementation, references code/files, proposes specific fixes",
  },
  {
    creature: "strategy",
    mustInclude: ["option", "trade-off", "tradeoff", "approach", "recommend", "risk", "phase", "consider"],
    mustExclude: ["here's the code", "```", "I'll implement"],
    description: "Propose-only: presents options with trade-offs, never implements",
  },
  {
    creature: "critic",
    mustInclude: ["concern", "risk", "failure", "missing", "assumption", "question", "what if", "issue", "problem", "gap", "before", "verify", "regression", "what works", "what doesn't"],
    mustExclude: ["I'll fix", "here's the implementation"],
    description: "Finds failure modes, probes assumptions, doesn't implement",
  },
  {
    creature: "research",
    mustInclude: ["investigat", "evidence", "finding", "source", "data", "analyz", "measure", "benchmark", "profil"],
    mustExclude: ["I'll implement", "here's the fix"],
    description: "Gathers evidence, cites sources, structured synthesis",
  },
  {
    creature: "ops",
    mustInclude: ["monitor", "metric", "deploy", "infra", "CDN", "cache", "server", "load", "performance", "health", "uptime"],
    mustExclude: ["I'll refactor the component"],
    description: "Infrastructure-focused, checks system health, monitoring",
  },
  {
    creature: "content",
    mustInclude: ["user", "communicat", "message", "audience", "experience", "draft", "status", "page"],
    mustExclude: [],
    description: "Audience-focused, thinks about communication and user experience",
  },
  {
    creature: "finance",
    mustInclude: ["cost", "budget", "impact", "revenue", "churn", "metric", "number", "calculat", "dollar", "$", "percent", "%"],
    mustExclude: [],
    description: "Quantifies cost/business impact, data-driven",
  },
  {
    creature: "general",
    mustInclude: ["specialist", "dev", "ops", "help", "team", "route", "dispatch", "look into"],
    mustExclude: [],
    description: "Routes to specialists, coordinates, conversational",
  },
  {
    creature: "road-runner",
    mustInclude: ["rout", "triag", "assign", "quick", "priority", "dispatch", "dev", "ops"],
    mustExclude: [],
    description: "Fast triage, classifies, routes immediately, telegraphic — must be concise vs control",
    maxLengthVsControl: 0.5,  // Road-runner should be ≤50% of control length (skill-only = 40k budget)
  },
  {
    creature: "chipmunk",
    mustInclude: ["knowledge", "document", "forest", "record", "log", "pattern", "organiz", "categor", "file"],
    mustExclude: [],
    description: "Focuses on knowledge organization, filing, patterns",
  },
  {
    creature: "deer",
    mustInclude: ["monitor", "pattern", "trend", "observ", "alert", "watch", "notice", "check", "might"],
    mustExclude: ["I'll fix", "here's the implementation", "let me deploy"],
    description: "Passive monitoring, gentle alerting, never intervenes directly",
  },
];

// ── Helpers ─────────────────────────────────────────────────

function containsAny(text: string, patterns: string[]): string[] {
  const lower = text.toLowerCase();
  return patterns.filter(p => lower.includes(p.toLowerCase()));
}

function formatResult(creature: string, response: string, check: BehaviorCheck, controlLength?: number): {
  pass: boolean;
  includeHits: string[];
  excludeHits: string[];
  concise: boolean | null;
  summary: string;
} {
  const includeHits = containsAny(response, check.mustInclude);
  const excludeHits = containsAny(response, check.mustExclude);

  const includePass = includeHits.length > 0;
  const excludePass = excludeHits.length === 0;

  // Conciseness check — if maxLengthVsControl is set and we have a control baseline
  let concise: boolean | null = null;
  if (check.maxLengthVsControl != null && controlLength && controlLength > 0) {
    const ratio = response.length / controlLength;
    concise = ratio <= check.maxLengthVsControl;
  }

  const pass = includePass && excludePass && (concise !== false);

  const parts: string[] = [];
  if (!includePass) parts.push(`MISSING expected signals (wanted one of: ${check.mustInclude.join(", ")})`);
  if (!excludePass) parts.push(`ANTI-PATTERN detected: ${excludeHits.join(", ")}`);
  if (concise === false) {
    const ratio = controlLength ? (response.length / controlLength).toFixed(2) : "?";
    parts.push(`TOO VERBOSE: ${response.length} chars = ${ratio}x control (max ${check.maxLengthVsControl}x)`);
  }
  if (pass) {
    let msg = `OK — matched: [${includeHits.join(", ")}]`;
    if (concise === true) {
      const ratio = controlLength ? (response.length / controlLength).toFixed(2) : "?";
      msg += ` — concise: ${ratio}x control`;
    }
    parts.push(msg);
  }

  return { pass, includeHits, excludeHits, concise, summary: parts.join("; ") };
}

// ── Trends Analysis ─────────────────────────────────────────

async function showTrends() {
  try {
    const data = await readFile(TRENDS_FILE, "utf-8");
    const trends: { runs: any[] } = JSON.parse(data);

    if (trends.runs.length === 0) {
      console.log("No trend data available yet. Run the verification script first.\n");
      return;
    }

    console.log(`\n=== ELLIE-369: Behavioral Trends ===`);
    console.log(`Total runs tracked: ${trends.runs.length}`);
    console.log(`Date range: ${new Date(trends.runs[0].timestamp).toLocaleDateString()} to ${new Date(trends.runs[trends.runs.length - 1].timestamp).toLocaleDateString()}\n`);

    // Overall pass rate trend
    console.log(`=== Overall Pass Rate ===\n`);
    trends.runs.forEach((run, i) => {
      const date = new Date(run.timestamp).toLocaleString();
      const passRate = run.totals.passed / (run.totals.passed + run.totals.failed) * 100;
      console.log(`  Run ${i + 1} (${date}): ${passRate.toFixed(1)}% pass (${run.totals.passed}/${run.totals.passed + run.totals.failed})`);
    });

    // Per-creature trends
    const creatures = new Set<string>();
    trends.runs.forEach(run => {
      run.results.forEach((r: any) => {
        if (r.creature !== "CONTROL (no archetype)") creatures.add(r.creature);
      });
    });

    console.log(`\n=== Per-Creature Trends ===\n`);

    for (const creature of Array.from(creatures).sort()) {
      console.log(`${creature}:`);

      const creatureData = trends.runs.map(run => {
        const result = run.results.find((r: any) => r.creature === creature);
        return result || null;
      }).filter(Boolean);

      if (creatureData.length === 0) continue;

      // Pass rate
      const passes = creatureData.filter((r: any) => r.pass).length;
      const passRate = (passes / creatureData.length * 100).toFixed(1);
      console.log(`  Pass rate: ${passRate}% (${passes}/${creatureData.length})`);

      // Length trend
      const lengths = creatureData.map((r: any) => r.responseLength);
      const avgLength = (lengths.reduce((a, b) => a + b, 0) / lengths.length).toFixed(0);
      const minLength = Math.min(...lengths);
      const maxLength = Math.max(...lengths);
      console.log(`  Response length: avg ${avgLength} chars (range: ${minLength}-${maxLength})`);

      // Speed trend
      const durations = creatureData.map((r: any) => r.durationMs);
      const avgDuration = (durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(0);
      console.log(`  Response time: avg ${avgDuration}ms`);

      // Signal consistency
      const signalCounts = creatureData.map((r: any) => r.includeHits?.length || 0);
      const avgSignals = (signalCounts.reduce((a, b) => a + b, 0) / signalCounts.length).toFixed(1);
      console.log(`  Signal hits: avg ${avgSignals} per run\n`);
    }

    // Mode detection trends
    console.log(`=== Mode Detection Trends ===\n`);
    trends.runs.forEach((run, i) => {
      const date = new Date(run.timestamp).toLocaleString();
      const total = run.modeDetection.passed + run.modeDetection.failed;
      const rate = (run.modeDetection.passed / total * 100).toFixed(1);
      console.log(`  Run ${i + 1} (${date}): ${rate}% pass (${run.modeDetection.passed}/${total})`);
    });

    console.log("\n");

  } catch (err) {
    console.error("Error reading trends file:", err);
    console.log("Run the verification script at least once to generate trend data.\n");
  }
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // Show trends and exit
  if (args.includes("--show-trends")) {
    await showTrends();
    process.exit(0);
  }

  const verbose = args.includes("--verbose");
  const singleCreature = args.find((a, i) => args[i - 1] === "--creature");

  // Load soul context (shared across all creatures)
  let soulContext = "";
  try {
    soulContext = await readFile(join(import.meta.dir, "../config/soul.md"), "utf-8");
  } catch { /* ok without */ }

  // Determine which creatures to test
  const allFiles = await readdir(ARCHETYPES_DIR);
  const archetypeNames = allFiles
    .filter(f => f.endsWith(".md"))
    .map(f => f.replace(".md", ""));

  const toTest = singleCreature
    ? archetypeNames.filter(n => n === singleCreature)
    : archetypeNames;

  if (toTest.length === 0) {
    console.error(`No archetypes found${singleCreature ? ` matching "${singleCreature}"` : ""}`);
    process.exit(1);
  }

  console.log(`\n=== ELLIE-369: Behavioral Verification ===`);
  console.log(`Model: ${MODEL}`);
  console.log(`Creatures: ${toTest.join(", ")}`);
  console.log(`Test prompt: "${TEST_PROMPT.slice(0, 80)}..."\n`);

  // Also run a control (no archetype) for baseline comparison
  const results: Array<{
    creature: string;
    response: string;
    check: ReturnType<typeof formatResult> | null;
    responseLength: number;
    durationMs: number;
  }> = [];

  // Control run (no archetype)
  if (!singleCreature) {
    console.log(`[control] Sending test prompt with NO archetype...`);
    const start = Date.now();
    const controlResp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: soulContext ? `${soulContext}\n\nYou are a helpful AI assistant.` : "You are a helpful AI assistant.",
      messages: [{ role: "user", content: TEST_PROMPT }],
    });
    const controlText = controlResp.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("");
    const controlMs = Date.now() - start;

    results.push({
      creature: "CONTROL (no archetype)",
      response: controlText,
      check: null,
      responseLength: controlText.length,
      durationMs: controlMs,
    });
    console.log(`[control] ${controlText.length} chars in ${controlMs}ms\n`);
    if (verbose) {
      console.log(`--- CONTROL RESPONSE ---`);
      console.log(controlText);
      console.log(`--- END ---\n`);
    }
  }

  // Run each creature
  for (const creature of toTest) {
    const archetypePath = join(ARCHETYPES_DIR, `${creature}.md`);
    const archetype = await readFile(archetypePath, "utf-8");

    const systemPrompt = [
      soulContext ? `# Ellie Soul\n${soulContext}\n---` : "",
      `# Behavioral Archetype\n${archetype}\n---`,
      `You are responding via a test harness. Keep responses concise and conversational.`,
    ].filter(Boolean).join("\n\n");

    console.log(`[${creature}] Sending test prompt...`);
    const start = Date.now();

    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: TEST_PROMPT }],
    });

    const text = resp.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("");
    const durationMs = Date.now() - start;

    const check = CHECKS.find(c => c.creature === creature);
    const controlResult = results.find(r => r.creature === "CONTROL (no archetype)");
    const controlLen = controlResult?.responseLength;
    const result = check ? formatResult(creature, text, check, controlLen) : null;

    results.push({
      creature,
      response: text,
      check: result,
      responseLength: text.length,
      durationMs,
    });

    const status = result ? (result.pass ? "PASS" : "FAIL") : "N/A";
    console.log(`[${creature}] ${status} — ${text.length} chars in ${durationMs}ms${result ? ` — ${result.summary}` : ""}`);

    if (verbose) {
      console.log(`--- ${creature.toUpperCase()} RESPONSE ---`);
      console.log(text);
      console.log(`--- END ---\n`);
    }
  }

  // ── Skill-only mode detection tests ────────────────────

  console.log(`\n=== SKILL-ONLY MODE DETECTION ===\n`);

  const modeTests: Array<{ input: string; expectMode: string; expectConfidence: string; label: string }> = [
    { input: "triage this", expectMode: "skill-only", expectConfidence: "high", label: "triage this → skill-only" },
    { input: "triage ELLIE-999", expectMode: "skill-only", expectConfidence: "high", label: "triage ELLIE-999 → skill-only" },
    { input: "route this to dev", expectMode: "skill-only", expectConfidence: "high", label: "route this → skill-only" },
    { input: "route ELLIE-42", expectMode: "skill-only", expectConfidence: "high", label: "route ELLIE-42 → skill-only" },
    { input: "just dispatch it", expectMode: "skill-only", expectConfidence: "high", label: "just dispatch → skill-only" },
    { input: "quick dispatch", expectMode: "skill-only", expectConfidence: "high", label: "quick dispatch → skill-only" },
    { input: "run and return", expectMode: "skill-only", expectConfidence: "high", label: "run and return → skill-only" },
    { input: "skill-only mode", expectMode: "skill-only", expectConfidence: "high", label: "manual: skill-only mode" },
    { input: "triage mode", expectMode: "skill-only", expectConfidence: "high", label: "manual: triage mode" },
    // ELLIE-380: Slash commands trigger skill-only
    { input: "/weather", expectMode: "skill-only", expectConfidence: "high", label: "/weather → skill-only" },
    { input: "/plane list issues", expectMode: "skill-only", expectConfidence: "high", label: "/plane → skill-only" },
    { input: "/briefing", expectMode: "skill-only", expectConfidence: "high", label: "/briefing → skill-only" },
    { input: "/calendar", expectMode: "skill-only", expectConfidence: "high", label: "/calendar → skill-only" },
    // ELLIE-380: Skill invocation phrases
    { input: "check the weather", expectMode: "skill-only", expectConfidence: "high", label: "check the weather → skill-only" },
    { input: "what's on my calendar", expectMode: "skill-only", expectConfidence: "high", label: "what's on my calendar → skill-only" },
    { input: "what's the weather", expectMode: "skill-only", expectConfidence: "high", label: "what's the weather → skill-only" },
    { input: "daily briefing", expectMode: "skill-only", expectConfidence: "high", label: "daily briefing → skill-only" },
    { input: "send an email to John", expectMode: "skill-only", expectConfidence: "high", label: "send email → skill-only" },
    // Negative: these should NOT trigger skill-only
    { input: "work on ELLIE-5", expectMode: "deep-work", expectConfidence: "high", label: "work on ELLIE-5 → deep-work (not skill-only)" },
    { input: "let's plan", expectMode: "strategy", expectConfidence: "high", label: "let's plan → strategy (not skill-only)" },
    { input: "good morning", expectMode: "conversation", expectConfidence: "high", label: "greeting → conversation (not skill-only)" },
  ];

  let modeTestsPassed = 0;
  let modeTestsFailed = 0;

  for (const t of modeTests) {
    const result = detectMode(t.input);
    const gotMode = result?.mode ?? "null";
    const gotConf = result?.confidence ?? "null";
    const modeOk = gotMode === t.expectMode;
    const confOk = gotConf === t.expectConfidence;
    const ok = modeOk && confOk;

    if (ok) {
      modeTestsPassed++;
      console.log(`  PASS  ${t.label}`);
    } else {
      modeTestsFailed++;
      console.log(`  FAIL  ${t.label} — got ${gotMode} (${gotConf})`);
    }
  }

  // Verify skill-only mode priorities load correctly
  const skillOnlyPriorities = getModeSectionPriorities("skill-only");
  const priorityChecks = [
    { label: "skills", expected: 1, got: skillOnlyPriorities["skills"] },
    { label: "archetype", expected: 2, got: skillOnlyPriorities["archetype"] },
    { label: "playbook-commands", expected: 2, got: skillOnlyPriorities["playbook-commands"] },
    { label: "soul (suppressed)", expected: 9, got: skillOnlyPriorities["soul"] },
    { label: "structured-context (suppressed)", expected: 9, got: skillOnlyPriorities["structured-context"] },
  ];

  for (const pc of priorityChecks) {
    if (pc.got === pc.expected) {
      modeTestsPassed++;
      console.log(`  PASS  skill-only priority: ${pc.label} = ${pc.got}`);
    } else {
      modeTestsFailed++;
      console.log(`  FAIL  skill-only priority: ${pc.label} — expected ${pc.expected}, got ${pc.got}`);
    }
  }

  // Verify token budget
  const skillOnlyBudget = getModeTokenBudget("skill-only");
  if (skillOnlyBudget === 40_000) {
    modeTestsPassed++;
    console.log(`  PASS  skill-only token budget = ${skillOnlyBudget}`);
  } else {
    modeTestsFailed++;
    console.log(`  FAIL  skill-only token budget — expected 40000, got ${skillOnlyBudget}`);
  }

  console.log(`\n  Mode tests: ${modeTestsPassed} passed, ${modeTestsFailed} failed\n`);

  // ── Summary ─────────────────────────────────────────────

  console.log(`\n=== RESULTS SUMMARY ===\n`);

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const r of results) {
    if (!r.check) {
      skipped++;
      console.log(`  SKIP  ${r.creature} (${r.responseLength} chars, ${r.durationMs}ms)`);
    } else if (r.check.pass) {
      passed++;
      console.log(`  PASS  ${r.creature} — ${r.check.summary}`);
    } else {
      failed++;
      console.log(`  FAIL  ${r.creature} — ${r.check.summary}`);
    }
  }

  // Include mode detection tests in totals
  passed += modeTestsPassed;
  failed += modeTestsFailed;

  console.log(`\n  Total: ${passed} passed, ${failed} failed, ${skipped} skipped\n`);

  // ── Save detailed results ─────────────────────────────

  const runResult = {
    timestamp: new Date().toISOString(),
    model: MODEL,
    testPrompt: TEST_PROMPT,
    results: results.map(r => ({
      creature: r.creature,
      pass: r.check?.pass ?? null,
      responseLength: r.responseLength,
      durationMs: r.durationMs,
      includeHits: r.check?.includeHits ?? [],
      excludeHits: r.check?.excludeHits ?? [],
      concise: r.check?.concise ?? null,
      summary: r.check?.summary ?? "control",
    })),
    modeDetection: {
      passed: modeTestsPassed,
      failed: modeTestsFailed,
    },
    totals: { passed, failed, skipped },
  };

  // Save current run to /tmp for quick review
  await Bun.write(join(RESULTS_DIR, "summary.json"), JSON.stringify(runResult, null, 2));

  // Save individual responses for manual review
  for (const r of results) {
    const safeName = r.creature.replace(/[^a-z0-9-]/gi, "_").toLowerCase();
    await Bun.write(join(RESULTS_DIR, `${safeName}.txt`), r.response);
  }

  console.log(`Detailed results saved to ${RESULTS_DIR}/`);

  // ── Append to trends file ──────────────────────────────

  let trends: { runs: typeof runResult[] } = { runs: [] };
  try {
    const existing = await readFile(TRENDS_FILE, "utf-8");
    trends = JSON.parse(existing);
  } catch {
    // First run — create new trends file
  }

  trends.runs.push(runResult);
  await writeFile(TRENDS_FILE, JSON.stringify(trends, null, 2));

  console.log(`Trends updated: ${trends.runs.length} total runs tracked in ${TRENDS_FILE}\n`);

  if (failed > 0) {
    console.log("Some creatures failed behavioral verification. Review the responses and tune archetypes as needed.\n");
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
