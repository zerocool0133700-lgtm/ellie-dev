/**
 * Deterministic Workflow Definitions — ELLIE-1077
 * YAML-based multi-step orchestration with explicit dependencies.
 * Steps execute in dependency order, not LLM discretion.
 */

import { log } from "./logger.ts";

const logger = log.child("workflow-definitions");

export interface WorkflowStep {
  id: string;
  skill?: string;
  agent?: string;
  depends_on?: string[];
  inputs?: Record<string, string>;  // Template expressions: ${{ steps.X.outputs.Y }}
  outputs?: string[];
  conditions?: string[];
  requires_approval?: boolean;
  on_failure?: "retry" | "skip" | "escalate";
  max_retries?: number;
}

export interface WorkflowDef {
  name: string;
  description: string;
  version: string;
  steps: WorkflowStep[];
  error_handling?: {
    on_step_failure?: "retry" | "skip" | "escalate";
    escalation_target?: string;
  };
}

export interface StepResult {
  stepId: string;
  status: "completed" | "failed" | "skipped" | "pending_approval";
  outputs: Record<string, unknown>;
  error?: string;
  durationMs: number;
}

export interface WorkflowResult {
  name: string;
  status: "completed" | "failed" | "partial";
  steps: StepResult[];
  totalDurationMs: number;
}

/**
 * Resolve execution order from dependencies (topological sort).
 */
export function resolveExecutionOrder(steps: WorkflowStep[]): string[] {
  const graph = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  // Initialize
  for (const step of steps) {
    graph.set(step.id, []);
    inDegree.set(step.id, 0);
  }

  // Build edges
  for (const step of steps) {
    for (const dep of step.depends_on ?? []) {
      if (!graph.has(dep)) {
        throw new Error(`Step "${step.id}" depends on unknown step "${dep}"`);
      }
      graph.get(dep)!.push(step.id);
      inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1);
    }
  }

  // Kahn's algorithm (topological sort)
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);

    for (const next of graph.get(current) ?? []) {
      const newDegree = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, newDegree);
      if (newDegree === 0) queue.push(next);
    }
  }

  if (order.length !== steps.length) {
    throw new Error("Circular dependency detected in workflow");
  }

  return order;
}

/**
 * Resolve template expressions in step inputs.
 * Supports: ${{ steps.classify.outputs.rules }}
 */
export function resolveInputs(
  inputs: Record<string, string>,
  stepResults: Map<string, StepResult>
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  for (const [key, template] of Object.entries(inputs)) {
    const match = template.match(/\$\{\{\s*steps\.(\w+)\.outputs\.(\w+)\s*\}\}/);
    if (match) {
      const [, stepId, outputKey] = match;
      const stepResult = stepResults.get(stepId);
      resolved[key] = stepResult?.outputs[outputKey] ?? null;
    } else {
      resolved[key] = template;
    }
  }

  return resolved;
}

/**
 * Check if step conditions are met.
 */
export function evaluateConditions(
  conditions: string[],
  stepResults: Map<string, StepResult>
): boolean {
  for (const cond of conditions) {
    // Simple: ${{ steps.X.outputs.Y > N }}
    const match = cond.match(/\$\{\{\s*steps\.(\w+)\.outputs\.(\w+)\s*(>|<|>=|<=|==|!=)\s*(\d+)\s*\}\}/);
    if (match) {
      const [, stepId, outputKey, op, valueStr] = match;
      const actual = Number(stepResults.get(stepId)?.outputs[outputKey] ?? 0);
      const expected = Number(valueStr);

      switch (op) {
        case ">": if (!(actual > expected)) return false; break;
        case "<": if (!(actual < expected)) return false; break;
        case ">=": if (!(actual >= expected)) return false; break;
        case "<=": if (!(actual <= expected)) return false; break;
        case "==": if (!(actual === expected)) return false; break;
        case "!=": if (!(actual !== expected)) return false; break;
      }
    }
  }
  return true;
}

// Export types for testing
export type { WorkflowStep as _WorkflowStep };
