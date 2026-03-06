/**
 * Dump built agent prompts to /tmp/prompts/ for inspection.
 * Mirrors the same assembly path used by orchestration-dispatch.ts.
 * Usage: bun run scripts/dump-prompts.ts
 */

import { mkdirSync, writeFileSync } from "fs";
import {
  buildPrompt,
  getAgentArchetype,
  getPsyContext,
  getPhaseContext,
  getHealthContext,
  refreshRiverDocs,
  getLastBuildMetrics,
} from "../src/prompt-builder.ts";

// Minimal stub agent configs matching what agent-router produces
const AGENTS: { name: string; system_prompt?: string; tools_enabled?: string[] }[] = [
  { name: "dev",          tools_enabled: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"] },
  { name: "research",     tools_enabled: ["Read", "WebSearch", "WebFetch", "Glob", "Grep"] },
  { name: "strategy",     tools_enabled: ["Read", "WebSearch", "WebFetch", "Glob", "Grep"] },
  { name: "critic",       tools_enabled: ["Read", "Glob", "Grep"] },
  { name: "finance",      tools_enabled: ["Read", "WebSearch", "WebFetch"] },
  { name: "ops",          tools_enabled: ["Read", "Bash", "Glob", "Grep"] },
  { name: "orchestrator", tools_enabled: ["Read", "Glob", "Grep"] },
  { name: "general",      tools_enabled: ["Read", "WebSearch", "WebFetch", "Glob", "Grep"] },
];

const OUT_DIR = "/tmp/prompts";
mkdirSync(OUT_DIR, { recursive: true });

// Pre-load River docs once (QMD cache warm-up)
process.stdout.write("Refreshing River docs... ");
try {
  await refreshRiverDocs();
  console.log("ok");
} catch (err) {
  console.log(`skipped (${err})`);
}

// Pre-load shared personality contexts once
process.stdout.write("Loading personality contexts... ");
const [psy, phase, health] = await Promise.all([
  getPsyContext(),
  getPhaseContext(),
  getHealthContext(),
]);
console.log("ok");

let built = 0;

for (const agent of AGENTS) {
  process.stdout.write(`Building ${agent.name}... `);

  const archetype = await getAgentArchetype(agent.name);

  const userMessage = `[dump-prompts] Inspect prompt for agent: ${agent.name}`;
  const workItemContext = `\nACTIVE WORK ITEM: ELLIE-000\nTitle: Prompt inspection\nPriority: medium\nDescription: Dump prompt for review.\n`;

  const prompt = buildPrompt(
    userMessage,
    undefined, undefined, undefined,
    "ellie-chat",
    { name: agent.name, tools_enabled: agent.tools_enabled },
    workItemContext,
    undefined, undefined, undefined,
    undefined, undefined,
    undefined,
    archetype, psy, phase, health,
  );

  const metrics = getLastBuildMetrics();
  const sections = metrics?.sections ?? [];
  const tokens = metrics?.totalTokens ?? "?";
  const budget = metrics?.tokenBudget ?? "?";

  const header = [
    `# Prompt dump: ${agent.name}`,
    `# Generated: ${new Date().toISOString()}`,
    `# Tokens: ${tokens} / ${budget}`,
    `# Sections (${sections.length}): ${sections.map(s => `${s.label}:${s.tokens}`).join(", ")}`,
    "",
    "---",
    "",
  ].join("\n");

  const outPath = `${OUT_DIR}/${agent.name}.md`;
  writeFileSync(outPath, header + prompt);
  console.log(`✓ ${tokens} tokens, ${sections.length} sections → ${outPath}`);
  built++;
}

console.log(`\nDone: ${built} prompts written to ${OUT_DIR}/`);
console.log(`\nFiles:`);
for (const agent of AGENTS) {
  const path = `${OUT_DIR}/${agent.name}.md`;
  try {
    const { statSync } = await import("fs");
    const stat = statSync(path);
    console.log(`  ${agent.name.padEnd(14)} ${(stat.size / 1024).toFixed(1)}KB`);
  } catch {}
}
