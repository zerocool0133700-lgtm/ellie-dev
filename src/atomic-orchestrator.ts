/**
 * Atomic Orchestrator — ELLIE-1084
 * Executes decomposed tasks with fresh CLI sessions per task.
 * Main loop: decompose → order → execute → verify → checkpoint → next
 * Inspired by GSD-2 auto.ts
 */

import { log } from "./logger.ts";
import { decomposeWorkItem, buildTaskPrompt, type AtomicTask, type TaskDecomposition } from "./task-decomposer.ts";
import { resolveExecutionOrder } from "./workflow-definitions.ts";
import { initFormation, saveCheckpoint, getResumePoint, canResume, type FormationState } from "./formation-checkpoint.ts";
import { estimateTokens } from "./relay-utils.ts";
import { recordUsage } from "./creature-cost-tracker.ts";
import { getAgentMemorySummary } from "./agent-memory-store.ts";

const logger = log.child("atomic-orchestrator");

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

export interface AtomicRunConfig {
  workItemId: string;
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  agent: string;             // Creature name (e.g., "james")
  model?: string;            // Model override
  agentContext?: string;     // Creature soul/archetype snippet
  codebaseContext?: string;  // Architecture notes, file paths
  onTaskStart?: (taskId: string, title: string) => void;
  onTaskComplete?: (taskId: string, output: string) => void;
  onTaskFail?: (taskId: string, error: string) => void;
}

export interface AtomicRunResult {
  workItemId: string;
  status: "completed" | "partial" | "failed";
  tasksCompleted: number;
  totalTasks: number;
  outputs: Map<string, string>;
  totalTokensIn: number;
  totalTokensOut: number;
  totalDurationMs: number;
  errors: Array<{ taskId: string; error: string }>;
}

/**
 * Execute a work item as a sequence of atomic tasks.
 * Each task gets a fresh Claude CLI session.
 */
export async function executeAtomicRun(config: AtomicRunConfig): Promise<AtomicRunResult> {
  const startTime = Date.now();
  const runId = `atomic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  logger.info("Atomic run starting", { workItemId: config.workItemId, agent: config.agent, runId });

  // Step 1: Decompose work item into tasks
  const decomposition = await decomposeWorkItem({
    workItemId: config.workItemId,
    title: config.title,
    description: config.description,
    acceptanceCriteria: config.acceptanceCriteria,
    codebaseContext: config.codebaseContext,
  });

  if (decomposition.tasks.length === 0) {
    return emptyResult(config.workItemId, startTime);
  }

  // Step 2: Resolve execution order via topological sort
  const workflowSteps = decomposition.tasks.map(t => ({
    id: t.id,
    depends_on: t.depends_on,
  }));

  let executionOrder: string[];
  try {
    executionOrder = resolveExecutionOrder(workflowSteps);
  } catch (err) {
    logger.error("Failed to resolve execution order", { error: String(err) });
    // Fallback to natural order
    executionOrder = decomposition.tasks.map(t => t.id);
  }

  // Step 3: Initialize formation state for checkpointing
  const formation = initFormation({
    formationId: runId,
    workflowName: config.workItemId,
    totalSteps: decomposition.tasks.length,
  });

  // Step 4: Execute tasks in order — fresh CLI session per task
  const outputs = new Map<string, string>();
  const errors: Array<{ taskId: string; error: string }> = [];
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let tasksCompleted = 0;

  // Load agent memory once (shared across tasks, read-only)
  const memoryContext = await getAgentMemorySummary(config.agent, 1500).catch(() => "");

  for (const taskId of executionOrder) {
    const task = decomposition.tasks.find(t => t.id === taskId);
    if (!task) continue;

    config.onTaskStart?.(taskId, task.title);
    logger.info("Executing atomic task", { taskId, title: task.title, runId });

    // Build focused prompt — only include outputs from this task's dependencies
    const priorOutputs = new Map<string, string>();
    for (const dep of task.depends_on ?? []) {
      const depOutput = outputs.get(dep);
      if (depOutput) priorOutputs.set(dep, depOutput);
    }

    const prompt = buildTaskPrompt({
      task,
      workItemId: config.workItemId,
      workItemTitle: config.title,
      priorOutputs,
      agentName: config.agent,
      agentContext: config.agentContext,
      memoryContext,
    });

    const promptTokens = estimateTokens(prompt);

    // Spawn fresh CLI session — --no-session-persistence ensures no state leaks
    try {
      const { spawn } = await import("bun");
      const args = [
        CLAUDE_PATH, "-p",
        "--output-format", "text",
        "--no-session-persistence",
      ];
      if (config.model) args.push("--model", config.model);

      const taskStart = Date.now();
      const proc = spawn(args, {
        stdin: new Blob([prompt]),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CLAUDECODE: "", ANTHROPIC_API_KEY: "" },
      });

      const timeoutMs = 120_000; // 2 minutes per task
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);

      const output = await new Response(proc.stdout).text();
      clearTimeout(timer);
      const exitCode = await proc.exited;
      const taskDuration = Date.now() - taskStart;

      if (exitCode !== 0 || timedOut) {
        const errorMsg = timedOut ? "Task timed out" : `Exit code ${exitCode}`;
        errors.push({ taskId, error: errorMsg });
        config.onTaskFail?.(taskId, errorMsg);
        saveCheckpoint(runId, { stepIndex: executionOrder.indexOf(taskId), stepId: taskId, status: "failed", outputs: {} });
        logger.warn("Atomic task failed", { taskId, error: errorMsg, durationMs: taskDuration });
        continue; // Continue with independent tasks
      }

      const outputTokens = estimateTokens(output);
      totalTokensIn += promptTokens;
      totalTokensOut += outputTokens;
      tasksCompleted++;

      outputs.set(taskId, output.trim());
      config.onTaskComplete?.(taskId, output.trim());

      // Record cost per task
      recordUsage({
        creature: config.agent,
        model: config.model || "sonnet",
        inputTokens: promptTokens,
        outputTokens,
      });

      // Checkpoint after each successful task
      saveCheckpoint(runId, {
        stepIndex: executionOrder.indexOf(taskId),
        stepId: taskId,
        status: "completed",
        outputs: { summary: output.trim().slice(0, 500) },
      });

      logger.info("Atomic task completed", {
        taskId,
        promptTokens,
        outputTokens,
        durationMs: taskDuration,
      });

    } catch (err) {
      const errorMsg = String(err);
      errors.push({ taskId, error: errorMsg });
      config.onTaskFail?.(taskId, errorMsg);
      saveCheckpoint(runId, { stepIndex: executionOrder.indexOf(taskId), stepId: taskId, status: "failed", outputs: {} });
      logger.error("Atomic task error", { taskId, error: errorMsg });
    }
  }

  // Step 5: Determine overall status
  const status = tasksCompleted === decomposition.tasks.length ? "completed"
    : tasksCompleted > 0 ? "partial"
    : "failed";

  const totalDurationMs = Date.now() - startTime;

  logger.info("Atomic run complete", {
    workItemId: config.workItemId,
    status,
    tasksCompleted,
    totalTasks: decomposition.tasks.length,
    totalTokensIn,
    totalTokensOut,
    totalDurationMs,
    errors: errors.length,
  });

  return {
    workItemId: config.workItemId,
    status,
    tasksCompleted,
    totalTasks: decomposition.tasks.length,
    outputs,
    totalTokensIn,
    totalTokensOut,
    totalDurationMs,
    errors,
  };
}

function emptyResult(workItemId: string, startTime: number): AtomicRunResult {
  return {
    workItemId,
    status: "failed",
    tasksCompleted: 0,
    totalTasks: 0,
    outputs: new Map(),
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalDurationMs: Date.now() - startTime,
    errors: [{ taskId: "decompose", error: "No tasks generated" }],
  };
}
