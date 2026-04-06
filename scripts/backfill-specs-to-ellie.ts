/**
 * Backfill existing spec docs to Ellie via Workshop Debrief API.
 * Reads each spec, extracts key sections, and posts a debrief so
 * Ellie's memory extraction pipeline plants the knowledge in the Forest.
 *
 * Usage: bun run scripts/backfill-specs-to-ellie.ts
 */

import { readFile } from "fs/promises";
import { Glob } from "bun";
import { join } from "path";

const BASE_DIR = join(import.meta.dir, "..");
const SPECS_DIR = join(BASE_DIR, "docs/superpowers/specs");
const PLANS_DIR = join(BASE_DIR, "docs/superpowers/plans");
const DEBRIEF_URL = "http://localhost:3001/api/workshop/debrief";
const BRIDGE_KEY = "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a";

// ── Spec extraction ─────────────────────────────────────────

function extractSpecKnowledge(content: string, filename: string): {
  summary: string;
  decisions: string[];
  scopes: string[];
} {
  const lines = content.split("\n");
  const decisions: string[] = [];
  const scopes: string[] = [];
  let summary = "";

  // Extract title
  const title = lines.find(l => l.startsWith("# "))?.replace("# ", "").trim() || filename;

  // Look for key sections
  let currentSection = "";
  for (const line of lines) {
    if (line.startsWith("## ") || line.startsWith("### ")) {
      currentSection = line.toLowerCase();
    }

    // Extract decisions/key design choices
    if (currentSection.includes("decision") || currentSection.includes("design") || currentSection.includes("approach") || currentSection.includes("architecture")) {
      if (line.startsWith("- ") && line.length > 20) {
        decisions.push(line.replace(/^- \*?\*?/, "").replace(/\*?\*?$/, "").trim());
      }
    }
  }

  // Detect scopes from content
  if (/coordinator|dispatch|agent.?router|orchestrat/i.test(content)) scopes.push("2/1");
  if (/forest|tree|scope|shared.?memor/i.test(content)) scopes.push("2/2");
  if (/dashboard|ellie.?home|nuxt/i.test(content)) scopes.push("2/3");
  if (/ellie.?life|life module/i.test(content)) scopes.push("2/5");
  if (/ellie.?learn|learn module/i.test(content)) scopes.push("2/6");
  if (/ellie.?work|work module|billing/i.test(content)) scopes.push("2/7");
  if (scopes.length === 0) scopes.push("2/1"); // default to ellie-dev

  // Build summary from first few paragraphs
  const goalMatch = content.match(/\*\*Goal:\*\*\s*(.+)/);
  const summarySection = content.match(/## (?:Summary|Overview|Problem|Context)\n\n([\s\S]*?)(?=\n##|\n---)/);
  if (goalMatch) {
    summary = `${title}. ${goalMatch[1]}`;
  } else if (summarySection) {
    summary = `${title}. ${summarySection[1].replace(/\n/g, " ").slice(0, 300).trim()}`;
  } else {
    // Take first substantive paragraph
    const firstPara = lines.filter(l => l.length > 50 && !l.startsWith("#") && !l.startsWith(">") && !l.startsWith("|")).slice(0, 2).join(" ");
    summary = `${title}. ${firstPara.slice(0, 300).trim()}`;
  }

  // Cap decisions at 8
  return { summary, decisions: decisions.slice(0, 8), scopes: [...new Set(scopes)] };
}

// ── Plan cataloging ─────────────────────────────────────────

function catalogPlan(content: string, filename: string): string {
  const title = content.match(/^# (.+)/m)?.[1] || filename;
  const goal = content.match(/\*\*Goal:\*\*\s*(.+)/)?.[1] || "";
  const taskCount = (content.match(/### Task \d+/g) || []).length;
  return `${filename}: "${title}" — ${taskCount} tasks. ${goal}`.slice(0, 200);
}

// ── Main ────────────────────────────────────────────────────

async function postDebrief(payload: Record<string, unknown>): Promise<boolean> {
  try {
    const resp = await fetch(DEBRIEF_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-key": BRIDGE_KEY,
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      console.error("  FAIL:", resp.status, await resp.text());
      return false;
    }
    const data = await resp.json() as { memoryId?: string };
    console.log("  OK:", data.memoryId);
    return true;
  } catch (err) {
    console.error("  ERROR:", err);
    return false;
  }
}

async function main() {
  // Phase 1: Process specs (deep extraction)
  console.log("=== Phase 1: Specs (deep extraction) ===\n");
  const specGlob = new Glob("*.md");
  const specs: string[] = [];
  for await (const file of specGlob.scan({ cwd: SPECS_DIR })) {
    specs.push(file);
  }
  specs.sort();

  let specCount = 0;
  for (const file of specs) {
    const content = await readFile(join(SPECS_DIR, file), "utf-8");
    const { summary, decisions, scopes } = extractSpecKnowledge(content, file);

    console.log(`Spec: ${file}`);
    console.log(`  Summary: ${summary.slice(0, 100)}...`);
    console.log(`  Decisions: ${decisions.length}, Scopes: ${scopes.join(", ")}`);

    const ok = await postDebrief({
      session: `Spec backfill: ${file.replace(".md", "")}`,
      repo: "ellie-dev",
      branch: "ellie/memory-system-fixes-1423-1427",
      decisions,
      docs_created: [`docs/superpowers/specs/${file}`],
      files_changed: [],
      scopes,
      summary,
    });

    if (ok) specCount++;

    // Small delay to not overwhelm the pipeline
    await new Promise(r => setTimeout(r, 500));
  }

  // Phase 2: Catalog plans (light touch — one combined debrief)
  console.log("\n=== Phase 2: Plans (catalog) ===\n");
  const planGlob = new Glob("*.md");
  const plans: string[] = [];
  for await (const file of planGlob.scan({ cwd: PLANS_DIR })) {
    plans.push(file);
  }
  plans.sort();

  const catalogEntries: string[] = [];
  for (const file of plans) {
    const content = await readFile(join(PLANS_DIR, file), "utf-8");
    const entry = catalogPlan(content, file);
    catalogEntries.push(entry);
    console.log(`  ${entry.slice(0, 120)}`);
  }

  // Post one combined debrief for all plans
  const planSummary = `Plan catalog: ${plans.length} implementation plans covering coordinator, agent system, dispatch observability, thread abstraction, LEOS ecosystem, Forest architecture, memory classification, layered prompt, and more. Each plan maps to a spec and contains task-by-task implementation steps with code.`;

  await postDebrief({
    session: "Plan catalog backfill",
    repo: "ellie-dev",
    branch: "ellie/memory-system-fixes-1423-1427",
    decisions: [
      `${plans.length} implementation plans cataloged in docs/superpowers/plans/`,
      ...catalogEntries.slice(0, 5), // First 5 as sample
    ],
    docs_created: plans.map(f => `docs/superpowers/plans/${f}`),
    files_changed: [],
    scopes: ["2/1"],
    summary: planSummary,
  });

  console.log(`\n=== Done: ${specCount} specs processed, ${plans.length} plans cataloged ===`);
}

main().catch(console.error);
