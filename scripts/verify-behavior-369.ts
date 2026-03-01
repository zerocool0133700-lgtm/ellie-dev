#!/usr/bin/env bun
/**
 * ELLIE-369: Behavioral Verification
 *
 * Dispatches a standard test prompt to each creature type and verifies
 * that the archetype produces observably different behavior.
 *
 * Uses the Anthropic API directly with Haiku for cost efficiency.
 *
 * Usage: bun run scripts/verify-behavior-369.ts [--creature dev] [--verbose]
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFile, readdir, writeFile } from "fs/promises";
import { join } from "path";

// ── Config ──────────────────────────────────────────────────

const ARCHETYPES_DIR = join(import.meta.dir, "../config/archetypes");
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 600;
const RESULTS_DIR = "/tmp/ellie-369-results";

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
    mustInclude: ["concern", "risk", "failure", "missing", "assumption", "question", "what if", "issue", "problem", "gap"],
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
    description: "Fast triage, classifies, routes immediately, telegraphic",
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

function formatResult(creature: string, response: string, check: BehaviorCheck): {
  pass: boolean;
  includeHits: string[];
  excludeHits: string[];
  summary: string;
} {
  const includeHits = containsAny(response, check.mustInclude);
  const excludeHits = containsAny(response, check.mustExclude);

  const includePass = includeHits.length > 0;
  const excludePass = excludeHits.length === 0;
  const pass = includePass && excludePass;

  const parts: string[] = [];
  if (!includePass) parts.push(`MISSING expected signals (wanted one of: ${check.mustInclude.join(", ")})`);
  if (!excludePass) parts.push(`ANTI-PATTERN detected: ${excludeHits.join(", ")}`);
  if (pass) parts.push(`OK — matched: [${includeHits.join(", ")}]`);

  return { pass, includeHits, excludeHits, summary: parts.join("; ") };
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
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
    const result = check ? formatResult(creature, text, check) : null;

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

  console.log(`\n  Total: ${passed} passed, ${failed} failed, ${skipped} skipped\n`);

  // ── Save detailed results ─────────────────────────────

  await Bun.write(join(RESULTS_DIR, "summary.json"), JSON.stringify({
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
      summary: r.check?.summary ?? "control",
    })),
    totals: { passed, failed, skipped },
  }, null, 2));

  // Save individual responses for manual review
  for (const r of results) {
    const safeName = r.creature.replace(/[^a-z0-9-]/gi, "_").toLowerCase();
    await Bun.write(join(RESULTS_DIR, `${safeName}.txt`), r.response);
  }

  console.log(`Detailed results saved to ${RESULTS_DIR}/\n`);

  if (failed > 0) {
    console.log("Some creatures failed behavioral verification. Review the responses and tune archetypes as needed.\n");
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
