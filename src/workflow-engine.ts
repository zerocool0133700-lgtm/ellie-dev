/**
 * Workflow State Machine Engine — ELLIE-836
 *
 * Orchestrates agent step transitions for declarative workflows.
 * Reads workflow configs, manages checkpoints, handles timeouts and failures.
 */

import { log } from "./logger.ts";
import type { WorkflowConfig, WorkflowStepConfig } from "./workflow-config.ts";
import {
  createInstance,
  createCheckpoint,
  updateCheckpoint,
  updateInstanceStatus,
  getInstance,
  getCheckpoints,
  getLastCompletedStep,
  type WorkflowInstance,
  type CheckpointStatus,
} from "./workflow-checkpoint.ts";
import {
  validateMessage,
  type AgentMessageContract,
  type MessageType,
} from "./workflow-message-types.ts";
import { getEscalationTarget, type RaciMatrix } from "./workflow-raci.ts";

const logger = log.child("workflow-engine");

// ── Types ────────────────────────────────────────────────────────

export type WorkflowEventType =
  | "workflow.started"
  | "workflow.step_started"
  | "workflow.step_completed"
  | "workflow.step_failed"
  | "workflow.step_skipped"
  | "workflow.step_timeout"
  | "workflow.completed"
  | "workflow.failed"
  | "workflow.escalated";

export interface WorkflowEvent {
  type: WorkflowEventType;
  workflow_id: string;
  step?: number;
  agent?: string;
  message?: string;
  timestamp: string;
}

export interface StepExecutor {
  (agent: string, instruction: string, input?: Record<string, unknown>): Promise<{
    output: string;
    metadata?: Record<string, unknown>;
  }>;
}

export interface WorkflowEngineOpts {
  sql: any;
  config: WorkflowConfig;
  executor: StepExecutor;
  raciMatrix?: RaciMatrix;
  contractRegistry?: Map<string, AgentMessageContract>;
  onEvent?: (event: WorkflowEvent) => void | Promise<void>;
  workItemId?: string;
  createdBy?: string;
}

// ── Engine ───────────────────────────────────────────────────────

/**
 * Start and run a workflow to completion.
 * Creates a workflow instance, executes steps sequentially,
 * manages checkpoints, handles failures with retry/escalate.
 */
export async function runWorkflow(opts: WorkflowEngineOpts): Promise<{
  instance: WorkflowInstance;
  events: WorkflowEvent[];
}> {
  const { sql, config, executor, onEvent } = opts;
  const events: WorkflowEvent[] = [];

  async function emit(event: WorkflowEvent): Promise<void> {
    events.push(event);
    if (onEvent) await onEvent(event);
  }

  // 1. Create instance
  const instance = await createInstance(sql, {
    work_item_id: opts.workItemId,
    context: { workflow_name: config.name },
    created_by: opts.createdBy,
  });

  await updateInstanceStatus(sql, instance.id, "in_progress");
  await emit({ type: "workflow.started", workflow_id: instance.id, timestamp: now() });

  // 2. Resume from last checkpoint if recovering
  const lastCompleted = await getLastCompletedStep(sql, instance.id);
  const startStep = lastCompleted + 1;

  // 3. Execute steps sequentially
  let lastOutput: Record<string, unknown> = {};

  for (let i = startStep; i < config.steps.length; i++) {
    const step = config.steps[i];
    const timeoutMs = (step.timeout_seconds ?? config.timeout_seconds ?? 120) * 1000;

    // Create checkpoint
    await createCheckpoint(sql, {
      workflow_id: instance.id,
      step: i,
      agent: step.agent,
      input: lastOutput,
    });

    await updateInstanceStatus(sql, instance.id, "in_progress", i);
    await emit({ type: "workflow.step_started", workflow_id: instance.id, step: i, agent: step.agent, timestamp: now() });

    // Validate message contracts if registry is available
    if (step.produces && opts.contractRegistry) {
      const v = validateMessage(opts.contractRegistry, step.agent, step.agent, step.produces);
      if (!v.valid) {
        logger.warn(`[workflow] Contract violation: ${v.error}`);
      }
    }

    // Execute with timeout
    try {
      const result = await executeWithTimeout(
        () => executor(step.agent, step.instruction, lastOutput),
        timeoutMs,
      );

      await updateCheckpoint(sql, instance.id, i, {
        status: "completed",
        output: { text: result.output, ...result.metadata },
      });

      lastOutput = { text: result.output, ...result.metadata, _prev_agent: step.agent };
      await emit({ type: "workflow.step_completed", workflow_id: instance.id, step: i, agent: step.agent, timestamp: now() });

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message.includes("timeout");

      if (isTimeout) {
        await emit({ type: "workflow.step_timeout", workflow_id: instance.id, step: i, agent: step.agent, message, timestamp: now() });
      }

      // Handle failure based on step config
      const failureAction = step.on_failure ?? "escalate";

      if (failureAction === "retry") {
        // Retry once
        try {
          const retryResult = await executeWithTimeout(
            () => executor(step.agent, step.instruction, lastOutput),
            timeoutMs,
          );
          await updateCheckpoint(sql, instance.id, i, {
            status: "completed",
            output: { text: retryResult.output, retried: true },
          });
          lastOutput = { text: retryResult.output, _prev_agent: step.agent };
          await emit({ type: "workflow.step_completed", workflow_id: instance.id, step: i, agent: step.agent, message: "succeeded on retry", timestamp: now() });
          continue;
        } catch {
          // Retry failed — fall through to escalate
        }
      }

      if (failureAction === "skip") {
        await updateCheckpoint(sql, instance.id, i, { status: "skipped", error_message: message });
        await emit({ type: "workflow.step_skipped", workflow_id: instance.id, step: i, agent: step.agent, message, timestamp: now() });
        continue;
      }

      // Escalate (default)
      await updateCheckpoint(sql, instance.id, i, { status: "failed", error_message: message });
      const escalationTarget = opts.raciMatrix
        ? getEscalationTarget(opts.raciMatrix, config.name)
        : "Dave";

      await emit({
        type: "workflow.escalated",
        workflow_id: instance.id,
        step: i,
        agent: step.agent,
        message: `Step ${i} (${step.agent}) failed: ${message}. Escalated to ${escalationTarget}.`,
        timestamp: now(),
      });

      await emit({ type: "workflow.step_failed", workflow_id: instance.id, step: i, agent: step.agent, message, timestamp: now() });
      await updateInstanceStatus(sql, instance.id, "failed", i, message);

      const updatedInstance = await getInstance(sql, instance.id);
      return { instance: updatedInstance ?? instance, events };
    }
  }

  // 4. All steps completed
  await updateInstanceStatus(sql, instance.id, "completed");
  await emit({ type: "workflow.completed", workflow_id: instance.id, timestamp: now() });

  const finalInstance = await getInstance(sql, instance.id);
  return { instance: finalInstance ?? instance, events };
}

// ── Helpers ──────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

async function executeWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Step execution timeout after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
}
