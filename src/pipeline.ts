/**
 * Multi-agent pipeline coordination — ELLIE-544
 *
 * State management for sequential multi-agent pipeline runs.
 * Each pipeline is a linked sequence of agent steps that run one-after-another,
 * with context (output) from each step passed forward to the next.
 *
 * Design:
 *   - In-memory registry keyed by pipeline ID and ticket ID
 *   - Pure state management functions (no I/O) — easy to unit test
 *   - `buildStepContext()` accumulates completed-step outputs for context passing
 *   - Parse helpers (`parseAgentSequence`, `parseStepDescriptions`) used by playbook.ts
 *   - `handlePipelineExecution()` drives the sequential dispatch loop (called by playbook.ts)
 */

import { log } from "./logger.ts";

const logger = log.child("pipeline");

// ── Types ────────────────────────────────────────────────────────────────────

export type StepStatus = "pending" | "running" | "completed" | "failed";
export type PipelineStatus = "pending" | "running" | "completed" | "failed";

export interface PipelineStep {
  agent: string;
  description: string;
  status: StepStatus;
  startedAt?: number;
  completedAt?: number;
  /** Captured output from this step — injected as context for subsequent steps. */
  output?: string;
}

export interface PipelineState {
  id: string;
  ticketId: string;
  steps: PipelineStep[];
  currentStepIndex: number;
  status: PipelineStatus;
  createdAt: number;
  completedAt?: number;
}

// ── In-memory registry ───────────────────────────────────────────────────────

const _pipelines = new Map<string, PipelineState>();
const _byTicket = new Map<string, string>(); // ticketId → pipelineId

// ── Parse helpers ────────────────────────────────────────────────────────────

const ARROW_RE = /→|->/;

/**
 * Parse agent sequence string from pipeline command.
 * Accepts both Unicode arrow (→) and ASCII arrow (->).
 * Normalises agent names to lowercase.
 *
 * "dev→research→dev" → ["dev", "research", "dev"]
 * "dev->research->dev" → ["dev", "research", "dev"]
 */
export function parseAgentSequence(raw: string): string[] {
  return raw.split(ARROW_RE).map(a => a.trim().toLowerCase()).filter(Boolean);
}

/**
 * Parse step description string from pipeline command.
 * Accepts both Unicode arrow (→) and ASCII arrow (->).
 * Preserves original casing.
 *
 * "implement→validate→finalize" → ["implement", "validate", "finalize"]
 */
export function parseStepDescriptions(raw: string): string[] {
  return raw.split(ARROW_RE).map(s => s.trim()).filter(Boolean);
}

// ── State management ─────────────────────────────────────────────────────────

/**
 * Create and register a new pipeline.
 * If descriptions is shorter than agents, remaining steps get auto-generated labels.
 */
export function createPipeline(
  ticketId: string,
  agents: string[],
  descriptions: string[],
  id: string = crypto.randomUUID(),
): PipelineState {
  if (agents.length === 0) throw new Error("Pipeline must have at least one step");

  // Pad descriptions if agent list is longer
  const descs = [...descriptions];
  while (descs.length < agents.length) {
    descs.push(`Step ${descs.length + 1}`);
  }

  const steps: PipelineStep[] = agents.map((agent, i) => ({
    agent,
    description: descs[i],
    status: "pending",
  }));

  const pipeline: PipelineState = {
    id,
    ticketId,
    steps,
    currentStepIndex: 0,
    status: "pending",
    createdAt: Date.now(),
  };

  _pipelines.set(id, pipeline);
  _byTicket.set(ticketId, id);

  logger.info(`[pipeline] Created pipeline ${id.slice(0, 8)} for ${ticketId} (${agents.length} steps)`);
  return pipeline;
}

/**
 * Mark the current step as running and transition pipeline status to "running".
 * Returns the updated pipeline, or null if not found.
 */
export function startCurrentStep(pipelineId: string, now = Date.now()): PipelineState | null {
  const p = _pipelines.get(pipelineId);
  if (!p) return null;

  const step = p.steps[p.currentStepIndex];
  if (!step || step.status === "running") return p; // already started or nothing to start

  step.status = "running";
  step.startedAt = now;
  p.status = "running";

  return p;
}

/**
 * Mark the current step as completed, capture its output, and advance to the next step.
 *
 * Returns:
 *   - `state` — updated pipeline state
 *   - `nextStep` — the next step to execute, or null if pipeline is done
 *   - `done` — true when all steps have completed
 */
export function completeCurrentStep(
  pipelineId: string,
  output?: string,
  now = Date.now(),
): { state: PipelineState; nextStep: PipelineStep | null; done: boolean } | null {
  const p = _pipelines.get(pipelineId);
  if (!p) return null;

  const step = p.steps[p.currentStepIndex];
  if (!step) return null;

  step.status = "completed";
  step.completedAt = now;
  step.output = output;

  const nextIndex = p.currentStepIndex + 1;
  if (nextIndex >= p.steps.length) {
    p.status = "completed";
    p.completedAt = now;
    return { state: p, nextStep: null, done: true };
  }

  p.currentStepIndex = nextIndex;
  return { state: p, nextStep: p.steps[nextIndex], done: false };
}

/**
 * Mark the current step (and the whole pipeline) as failed.
 */
export function failCurrentStep(
  pipelineId: string,
  reason?: string,
  now = Date.now(),
): PipelineState | null {
  const p = _pipelines.get(pipelineId);
  if (!p) return null;

  const step = p.steps[p.currentStepIndex];
  if (step) {
    step.status = "failed";
    step.completedAt = now;
    if (reason) step.output = `FAILED: ${reason}`;
  }

  p.status = "failed";
  p.completedAt = now;
  return p;
}

/** Get pipeline by ID. */
export function getPipelineState(pipelineId: string): PipelineState | null {
  return _pipelines.get(pipelineId) ?? null;
}

/** Get the active pipeline for a ticket (most recently created). */
export function getPipelineForTicket(ticketId: string): PipelineState | null {
  const id = _byTicket.get(ticketId);
  return id ? (_pipelines.get(id) ?? null) : null;
}

/** Get all pipeline states — for status endpoint or monitoring. */
export function getAllPipelines(): PipelineState[] {
  return Array.from(_pipelines.values());
}

// ── Context accumulation ─────────────────────────────────────────────────────

/**
 * Build accumulated context string from all completed steps before the current one.
 * Injected into the prompt of each subsequent step so agents have prior work as context.
 */
export function buildStepContext(pipeline: PipelineState): string {
  const completed = pipeline.steps
    .slice(0, pipeline.currentStepIndex)
    .filter(s => s.status === "completed" && s.output);

  if (completed.length === 0) return "";

  return completed
    .map((s, i) =>
      `=== Step ${i + 1}: ${s.agent} — ${s.description} ===\n${s.output ?? ""}`
    )
    .join("\n\n");
}

// ── Pipeline summary ─────────────────────────────────────────────────────────

/** Human-readable pipeline summary — used in notifications. */
export function formatPipelineSummary(pipeline: PipelineState): string {
  const stepList = pipeline.steps
    .map((s, i) => {
      const marker = s.status === "completed" ? "✓"
        : s.status === "running" ? "▶"
        : s.status === "failed" ? "✗"
        : "○";
      return `${marker} ${i + 1}. ${s.agent}: ${s.description}`;
    })
    .join("\n");
  return `Pipeline ${pipeline.ticketId} [${pipeline.status}]\n${stepList}`;
}

// ── Test utilities ───────────────────────────────────────────────────────────

/** Reset all pipeline state — for unit tests only. */
export function _resetPipelinesForTesting(): void {
  _pipelines.clear();
  _byTicket.clear();
}
