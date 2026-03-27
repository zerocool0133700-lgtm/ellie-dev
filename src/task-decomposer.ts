/**
 * Task Decomposer — ELLIE-1084
 * Breaks a work item into atomic tasks for fresh-session execution.
 * Each task gets its own Claude CLI session with focused context.
 * Inspired by GSD-2 auto-dispatch.ts (Milestone → Slice → Task)
 */

import { log } from "./logger.ts";
import { estimateTokens } from "./relay-utils.ts";

const logger = log.child("task-decomposer");

export interface AtomicTask {
  id: string;
  title: string;
  description: string;
  depends_on: string[];
  files?: string[];           // Files this task will touch
  skills_needed?: string[];   // Skills to inject
  acceptance_criteria?: string[];
  estimated_tokens?: number;  // Estimated context budget needed
  verification?: string;      // Command to verify task completion
}

export interface TaskDecomposition {
  workItemId: string;
  title: string;
  tasks: AtomicTask[];
  totalTasks: number;
}

/**
 * Decompose a work item description into atomic tasks using Haiku.
 * Returns structured tasks with dependencies.
 */
export async function decomposeWorkItem(opts: {
  workItemId: string;
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  codebaseContext?: string;  // Relevant file paths, architecture notes
}): Promise<TaskDecomposition> {
  const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

  const prompt = `Decompose this work item into atomic tasks. Each task should be completable in a single focused session (10-50 minutes of agent work).

WORK ITEM: ${opts.workItemId} — ${opts.title}

DESCRIPTION:
${opts.description}

${opts.acceptanceCriteria?.length ? `ACCEPTANCE CRITERIA:\n${opts.acceptanceCriteria.map(c => `- ${c}`).join("\n")}` : ""}

${opts.codebaseContext ? `CODEBASE CONTEXT:\n${opts.codebaseContext}` : ""}

Return a JSON array of tasks:
[
  {
    "id": "task-1",
    "title": "Short title",
    "description": "What to do in 2-3 sentences",
    "depends_on": [],
    "files": ["src/foo.ts"],
    "skills_needed": ["github"],
    "acceptance_criteria": ["Tests pass", "No type errors"],
    "verification": "bun test tests/foo.test.ts"
  }
]

Rules:
- Each task should be ATOMIC — one clear objective
- Tasks should be ordered by dependency (later tasks depend on earlier)
- Include file paths where known
- Include verification commands (test, type-check, lint)
- 3-8 tasks for a typical ticket
- Return ONLY valid JSON array, no explanation`;

  try {
    const { spawn } = await import("bun");
    const args = [
      CLAUDE_PATH, "-p",
      "--output-format", "text",
      "--no-session-persistence",
      "--allowedTools", "",
      "--model", "haiku",
    ];

    const proc = spawn(args, {
      stdin: new Blob([prompt]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDECODE: "", ANTHROPIC_API_KEY: "" },
    });

    const timer = setTimeout(() => proc.kill(), 30_000);
    const output = await new Response(proc.stdout).text();
    clearTimeout(timer);
    await proc.exited;

    // Parse JSON — strip markdown fences if present
    const cleaned = output.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
    const tasks: AtomicTask[] = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

    logger.info("Decomposed work item", { workItemId: opts.workItemId, tasks: tasks.length });

    return {
      workItemId: opts.workItemId,
      title: opts.title,
      tasks,
      totalTasks: tasks.length,
    };
  } catch (err) {
    logger.error("Task decomposition failed", { error: String(err) });
    // Fallback: single task for the whole work item
    return {
      workItemId: opts.workItemId,
      title: opts.title,
      tasks: [{
        id: "task-1",
        title: opts.title,
        description: opts.description,
        depends_on: [],
      }],
      totalTasks: 1,
    };
  }
}

/**
 * Build a focused prompt for a single atomic task.
 * Includes only relevant context — no stale conversation history.
 */
export function buildTaskPrompt(opts: {
  task: AtomicTask;
  workItemId: string;
  workItemTitle: string;
  priorOutputs?: Map<string, string>;  // Outputs from completed dependency tasks
  agentName?: string;
  agentContext?: string;  // Creature archetype/soul snippet
  memoryContext?: string; // Scoped agent memory
  fileContext?: string;   // Relevant file contents
}): string {
  const sections: string[] = [];

  // Identity (minimal)
  if (opts.agentContext) {
    sections.push(opts.agentContext);
  }

  // Work item context
  sections.push(`## Work Item: ${opts.workItemId} — ${opts.workItemTitle}`);
  sections.push("");

  // Current task
  sections.push(`## Current Task: ${opts.task.title}`);
  sections.push(opts.task.description);
  sections.push("");

  // Acceptance criteria
  if (opts.task.acceptance_criteria?.length) {
    sections.push("## Acceptance Criteria");
    for (const c of opts.task.acceptance_criteria) {
      sections.push(`- [ ] ${c}`);
    }
    sections.push("");
  }

  // Verification
  if (opts.task.verification) {
    sections.push(`## Verification`);
    sections.push(`Run: \`${opts.task.verification}\``);
    sections.push("");
  }

  // Prior task outputs (from dependencies)
  if (opts.priorOutputs && opts.priorOutputs.size > 0) {
    sections.push("## Context from Prior Tasks");
    for (const [taskId, output] of opts.priorOutputs) {
      // Truncate long outputs
      const truncated = output.length > 2000 ? output.slice(0, 2000) + "\n[...truncated]" : output;
      sections.push(`### ${taskId}`);
      sections.push(truncated);
    }
    sections.push("");
  }

  // Agent memory (scoped)
  if (opts.memoryContext) {
    sections.push("## Agent Memory");
    sections.push(opts.memoryContext);
    sections.push("");
  }

  // File context
  if (opts.fileContext) {
    sections.push("## Relevant Files");
    sections.push(opts.fileContext);
    sections.push("");
  }

  // Instructions
  sections.push("## Instructions");
  sections.push("Complete ONLY this task. Do not work on other tasks.");
  sections.push("When done, summarize what you changed and any decisions made.");

  return sections.join("\n");
}
