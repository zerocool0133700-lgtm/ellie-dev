#!/usr/bin/env bun
/**
 * Work Session Starter
 *
 * Interactive script that fetches open Plane issues, lets you pick one,
 * posts to /work-session/start, and opens Claude Code with the work item loaded.
 *
 * Usage: bun run work:start
 */

import { config } from "dotenv";
import { resolve } from "path";
import { spawn } from "child_process";

// Load .env from project root
config({ path: resolve(import.meta.dir, "../.env") });

const PLANE_API_KEY = process.env.PLANE_API_KEY;
const PLANE_BASE_URL = (process.env.PLANE_BASE_URL || "https://plane.ellie-labs.dev").replace(/\/api\/v1\/?$/, "");
const PLANE_WORKSPACE = process.env.PLANE_WORKSPACE_SLUG || process.env.PLANE_WORKSPACE || "evelife";
const RELAY_URL = process.env.RELAY_URL || "http://localhost:3001";

// Accept project identifier as CLI arg, default to ELLIE
const PROJECT_ARG = process.argv[2]?.toUpperCase();

if (!PLANE_API_KEY) {
  console.error("PLANE_API_KEY not set in .env");
  process.exit(1);
}

// --- Plane API ---

async function planeGet(path: string) {
  const res = await fetch(`${PLANE_BASE_URL}/api/v1/workspaces/${PLANE_WORKSPACE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      "x-api-key": PLANE_API_KEY!,
    },
  });
  if (!res.ok) throw new Error(`Plane ${res.status}: ${await res.text()}`);
  return res.json();
}

interface PlaneProject {
  id: string;
  identifier: string;
  name: string;
}

interface PlaneIssue {
  id: string;
  name: string;
  sequence_id: number;
  priority: string;
  state_detail?: { name: string; group: string };
}

async function getProjects(): Promise<PlaneProject[]> {
  const data = await planeGet("/projects/");
  return data.results;
}

async function getOpenIssues(projectId: string): Promise<PlaneIssue[]> {
  // Get states to find non-completed ones
  const statesData = await planeGet(`/projects/${projectId}/states/`);
  const openStateIds = statesData.results
    .filter((s: any) => !["completed", "cancelled"].includes(s.group))
    .map((s: any) => s.id);

  // Build state lookup
  const stateMap = new Map<string, { name: string; group: string }>();
  for (const s of statesData.results) {
    stateMap.set(s.id, { name: s.name, group: s.group });
  }

  // Get issues filtered to open states
  const issuesData = await planeGet(`/projects/${projectId}/issues/`);
  return issuesData.results
    .filter((i: any) => openStateIds.includes(i.state))
    .map((i: any) => ({
      ...i,
      state_detail: stateMap.get(i.state),
    }))
    .sort((a: PlaneIssue, b: PlaneIssue) => a.sequence_id - b.sequence_id);
}

// --- Interactive menu ---

function prompt(question: string): Promise<string> {
  process.stdout.write(question);
  return new Promise((resolve) => {
    let input = "";
    process.stdin.setRawMode?.(false);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data) => {
      input = data.toString().trim();
      process.stdin.pause();
      resolve(input);
    });
  });
}

const priorityIcon: Record<string, string> = {
  urgent: "!!!",
  high: "!! ",
  medium: "!  ",
  low: "   ",
  none: "   ",
};

const stateIcon: Record<string, string> = {
  backlog: "[ ]",
  unstarted: "[ ]",
  started: "[>]",
  completed: "[x]",
  cancelled: "[-]",
};

// --- Main ---

async function main() {
  console.log("\n  Work Session Starter\n");

  // Resolve project
  const projects = await getProjects();
  let project: PlaneProject | undefined;

  if (PROJECT_ARG) {
    project = projects.find((p) => p.identifier === PROJECT_ARG);
    if (!project) {
      console.error(`  Project "${PROJECT_ARG}" not found.`);
      console.error(`  Available: ${projects.map((p) => p.identifier).join(", ")}\n`);
      process.exit(1);
    }
  } else if (projects.length === 1) {
    project = projects[0];
  } else {
    // Multiple projects — let user pick
    console.log("  Projects:\n");
    for (let i = 0; i < projects.length; i++) {
      console.log(`  ${i + 1}) ${projects[i].identifier.padEnd(8)} ${projects[i].name}`);
    }
    console.log("");
    const answer = await prompt("  Select project (number): ");
    const idx = parseInt(answer) - 1;
    if (isNaN(idx) || idx < 0 || idx >= projects.length) {
      console.error("  Invalid selection.\n");
      process.exit(1);
    }
    project = projects[idx];
  }

  const identifier = project.identifier;
  console.log(`  Project: ${identifier} (${project.name})\n`);

  const issues = await getOpenIssues(project.id);

  if (issues.length === 0) {
    console.log("  No open issues found.\n");
    process.exit(0);
  }

  // Display menu
  console.log("  Open issues:\n");
  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    const num = String(i + 1).padStart(2);
    const id = `${identifier}-${issue.sequence_id}`;
    const pri = priorityIcon[issue.priority] || "   ";
    const state = stateIcon[issue.state_detail?.group || "backlog"] || "[ ]";
    console.log(`  ${num}) ${state} ${pri} ${id.padEnd(10)} ${issue.name}`);
  }

  console.log("");
  const answer = await prompt("  Select issue (number or q to quit): ");

  if (answer === "q" || answer === "") {
    console.log("  Cancelled.\n");
    process.exit(0);
  }

  const index = parseInt(answer) - 1;
  if (isNaN(index) || index < 0 || index >= issues.length) {
    console.error("  Invalid selection.\n");
    process.exit(1);
  }

  const selected = issues[index];
  const workItemId = `${identifier}-${selected.sequence_id}`;

  console.log(`\n  Starting session for ${workItemId}: ${selected.name}\n`);

  // Post to relay
  try {
    const res = await fetch(`${RELAY_URL}/api/work-session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        work_item_id: workItemId,
        title: selected.name,
        project: "ellie-dev",
        agent: "dev",
      }),
    });
    const data = await res.json() as any;
    if (data.success) {
      console.log(`  Session started (${data.session_id})`);
    } else {
      console.warn(`  Relay warning: ${data.error}`);
    }
  } catch {
    console.warn("  Relay not reachable — skipping notification");
  }

  // Launch Claude Code with work item context
  console.log(`  Opening Claude Code...\n`);
  const claude = spawn("claude", [`work on ${workItemId}`], {
    stdio: "inherit",
    cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env, CLAUDECODE: undefined },
  });

  claude.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
