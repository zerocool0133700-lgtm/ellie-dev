/**
 * RAPID-RACI Role Matrix — ELLIE-835
 *
 * Maps agents to decision roles per workflow type.
 * R = Recommend, A = Agree, P = Perform, I = Input, D = Decide
 *
 * Loaded from config/raci-matrix.yaml at startup with hot-reload.
 */

import { readFileSync, existsSync, watchFile, unwatchFile } from "fs";

// ── Types ────────────────────────────────────────────────────────

export type RaciRole = "R" | "A" | "P" | "I" | "D";

export interface RaciEntry {
  agent: string;
  role: RaciRole;
}

export interface WorkflowRaci {
  workflow: string;
  roles: RaciEntry[];
}

export interface RaciMatrix {
  workflows: WorkflowRaci[];
}

// ── Matrix operations ────────────────────────────────────────────

/** Parse a RACI matrix from YAML-like config (simple key: value format). */
export function parseRaciMatrix(content: string): RaciMatrix {
  const workflows: WorkflowRaci[] = [];
  let current: WorkflowRaci | null = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Workflow header: "workflow: research"
    const workflowMatch = line.match(/^workflow:\s*(.+)$/);
    if (workflowMatch) {
      if (current) workflows.push(current);
      current = { workflow: workflowMatch[1].trim(), roles: [] };
      continue;
    }

    // Role entry: "dev: P" or "strategy: R,D"
    if (current) {
      const roleMatch = line.match(/^(\w+):\s*([RAPID,\s]+)$/);
      if (roleMatch) {
        const agent = roleMatch[1].trim();
        const roles = roleMatch[2].split(",").map(r => r.trim()).filter(r => "RAPID".includes(r));
        for (const r of roles) {
          current.roles.push({ agent, role: r as RaciRole });
        }
      }
    }
  }
  if (current) workflows.push(current);

  return { workflows };
}

/** Look up an agent's RACI role for a given workflow type. */
export function getAgentRole(matrix: RaciMatrix, workflow: string, agent: string): RaciRole[] {
  const wf = matrix.workflows.find(w => w.workflow === workflow);
  if (!wf) return [];
  return wf.roles.filter(r => r.agent === agent).map(r => r.role);
}

/** Find the Decider for a workflow type. */
export function getDecider(matrix: RaciMatrix, workflow: string): string | null {
  const wf = matrix.workflows.find(w => w.workflow === workflow);
  if (!wf) return null;
  const decider = wf.roles.find(r => r.role === "D");
  return decider?.agent ?? null;
}

/** Find all Performers for a workflow type. */
export function getPerformers(matrix: RaciMatrix, workflow: string): string[] {
  const wf = matrix.workflows.find(w => w.workflow === workflow);
  if (!wf) return [];
  return wf.roles.filter(r => r.role === "P").map(r => r.agent);
}

/** Find the Recommender for a workflow type. */
export function getRecommender(matrix: RaciMatrix, workflow: string): string | null {
  const wf = matrix.workflows.find(w => w.workflow === workflow);
  if (!wf) return null;
  const rec = wf.roles.find(r => r.role === "R");
  return rec?.agent ?? null;
}

/** Find the escalation target for a workflow (who Decides). */
export function getEscalationTarget(matrix: RaciMatrix, workflow: string): string {
  return getDecider(matrix, workflow) ?? "Dave";
}

/** Validate the matrix — every workflow must have exactly one Decider. */
export function validateMatrix(matrix: RaciMatrix): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const wf of matrix.workflows) {
    const deciders = wf.roles.filter(r => r.role === "D");
    if (deciders.length === 0) {
      errors.push(`Workflow "${wf.workflow}" has no Decider (D)`);
    } else if (deciders.length > 1) {
      errors.push(`Workflow "${wf.workflow}" has multiple Deciders: ${deciders.map(d => d.agent).join(", ")}`);
    }

    const performers = wf.roles.filter(r => r.role === "P");
    if (performers.length === 0) {
      errors.push(`Workflow "${wf.workflow}" has no Performer (P)`);
    }
  }
  return { valid: errors.length === 0, errors };
}

// ── File loading ─────────────────────────────────────────────────

const DEFAULT_PATH = "config/raci-matrix.txt";
let _cachedMatrix: RaciMatrix | null = null;

export function loadMatrix(path?: string): RaciMatrix {
  const filePath = path ?? DEFAULT_PATH;
  if (!existsSync(filePath)) return { workflows: [] };
  const content = readFileSync(filePath, "utf-8");
  _cachedMatrix = parseRaciMatrix(content);
  return _cachedMatrix;
}

export function getCachedMatrix(): RaciMatrix {
  if (!_cachedMatrix) return loadMatrix();
  return _cachedMatrix;
}

/** For testing — inject a matrix without file I/O. */
export function _injectMatrixForTesting(matrix: RaciMatrix): void {
  _cachedMatrix = matrix;
}
