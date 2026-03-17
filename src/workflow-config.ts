/**
 * Declarative Workflow Config Parser — ELLIE-837
 *
 * Reads YAML workflow definitions from config/workflows/ and validates
 * them against archetype schemas and the RACI matrix.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { type MessageType, MESSAGE_TYPES } from "./archetype-schema.ts";

// ── Types ────────────────────────────────────────────────────────

export interface WorkflowStepConfig {
  agent: string;
  action: string;
  instruction: string;
  timeout_seconds?: number;
  produces?: MessageType;
  consumes?: MessageType;
  parallel_with?: number[];
  on_failure?: "retry" | "skip" | "escalate";
}

export interface WorkflowConfig {
  name: string;
  description: string;
  triggers?: string[];
  steps: WorkflowStepConfig[];
  timeout_seconds?: number;
  on_complete?: string;
}

export interface WorkflowValidationError {
  field: string;
  message: string;
}

export interface WorkflowValidationResult {
  valid: boolean;
  errors: WorkflowValidationError[];
}

// ── Simple YAML parser (for workflow configs) ────────────────────

/**
 * Parse a simple YAML workflow config. Handles:
 * - Top-level scalar fields (name, description, timeout_seconds)
 * - Top-level array fields (triggers)
 * - steps array with nested objects
 */
export function parseWorkflowYaml(content: string): WorkflowConfig | null {
  const lines = content.split("\n");
  const config: Record<string, any> = {};
  let currentArray: string | null = null;
  let currentArrayItems: any[] = [];
  let currentObj: Record<string, any> | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim().startsWith("#") || line.trim() === "") continue;

    // Top-level key: value
    const topMatch = line.match(/^(\w[\w_]*):\s*(.*)$/);
    if (topMatch && !line.startsWith("  ") && !line.startsWith("\t")) {
      // Flush previous array
      if (currentArray) {
        if (currentObj) { currentArrayItems.push(currentObj); currentObj = null; }
        config[currentArray] = currentArrayItems;
        currentArray = null;
        currentArrayItems = [];
      }

      const key = topMatch[1];
      const val = topMatch[2].trim();

      if (val === "" || val === "|") {
        // Start of array or block
        currentArray = key;
        currentArrayItems = [];
        continue;
      }

      // Inline value
      if (val.startsWith("[") && val.endsWith("]")) {
        config[key] = val.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      } else if (!isNaN(Number(val))) {
        config[key] = Number(val);
      } else {
        config[key] = val.replace(/^["']|["']$/g, "");
      }
      continue;
    }

    // Array item: "  - something" or "  - agent: dev"
    const arrayItemMatch = line.match(/^\s+-\s+(.+)$/);
    if (arrayItemMatch && currentArray) {
      if (currentObj) { currentArrayItems.push(currentObj); currentObj = null; }

      const itemVal = arrayItemMatch[1].trim();
      const kvMatch = itemVal.match(/^(\w+):\s*(.+)$/);
      if (kvMatch) {
        currentObj = { [kvMatch[1]]: parseYamlValue(kvMatch[2].trim()) };
      } else {
        currentArrayItems.push(parseYamlValue(itemVal));
      }
      continue;
    }

    // Nested key under array item: "    skill: code_changes"
    const nestedMatch = line.match(/^\s{4,}(\w[\w_]*):\s*(.+)$/);
    if (nestedMatch && currentObj) {
      currentObj[nestedMatch[1]] = parseYamlValue(nestedMatch[2].trim());
      continue;
    }
  }

  // Flush last array
  if (currentArray) {
    if (currentObj) currentArrayItems.push(currentObj);
    config[currentArray] = currentArrayItems;
  }

  if (!config.name || !config.steps) return null;

  return {
    name: config.name,
    description: config.description ?? "",
    triggers: config.triggers as string[] | undefined,
    steps: (config.steps as Record<string, any>[]).map(s => ({
      agent: s.agent ?? "",
      action: s.skill ?? s.action ?? "none",
      instruction: s.instruction ?? "",
      timeout_seconds: s.timeout_seconds ?? undefined,
      produces: s.produces as MessageType | undefined,
      consumes: s.consumes as MessageType | undefined,
      on_failure: s.on_failure as "retry" | "skip" | "escalate" | undefined,
    })),
    timeout_seconds: config.timeout_seconds as number | undefined,
    on_complete: config.on_complete as string | undefined,
  };
}

function parseYamlValue(val: string): string | number | boolean {
  if (val === "true") return true;
  if (val === "false") return false;
  if (val === "none" || val === "null") return "none";
  if (!isNaN(Number(val)) && val !== "") return Number(val);
  return val.replace(/^["']|["']$/g, "");
}

// ── Validation ───────────────────────────────────────────────────

/** Known agents for validation. */
const KNOWN_AGENTS = new Set(["dev", "research", "critic", "content", "strategy", "finance", "general", "ops"]);

export function validateWorkflowConfig(
  config: WorkflowConfig,
  knownAgents?: Set<string>,
): WorkflowValidationResult {
  const errors: WorkflowValidationError[] = [];
  const agents = knownAgents ?? KNOWN_AGENTS;

  if (!config.name.trim()) {
    errors.push({ field: "name", message: "Workflow name is required" });
  }

  if (config.steps.length === 0) {
    errors.push({ field: "steps", message: "Workflow must have at least one step" });
  }

  const validMessageTypes = new Set<string>(MESSAGE_TYPES);

  for (let i = 0; i < config.steps.length; i++) {
    const step = config.steps[i];
    if (!step.agent) {
      errors.push({ field: `steps[${i}].agent`, message: "Step must have an agent" });
    } else if (!agents.has(step.agent)) {
      errors.push({ field: `steps[${i}].agent`, message: `Unknown agent "${step.agent}"` });
    }

    if (step.produces && !validMessageTypes.has(step.produces)) {
      errors.push({ field: `steps[${i}].produces`, message: `Invalid message type "${step.produces}"` });
    }
    if (step.consumes && !validMessageTypes.has(step.consumes)) {
      errors.push({ field: `steps[${i}].consumes`, message: `Invalid message type "${step.consumes}"` });
    }

    if (step.timeout_seconds !== undefined && step.timeout_seconds <= 0) {
      errors.push({ field: `steps[${i}].timeout_seconds`, message: "Timeout must be positive" });
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── File loading ─────────────────────────────────────────────────

const WORKFLOWS_DIR = "config/workflows";

export function loadWorkflowConfigs(dir?: string): WorkflowConfig[] {
  const workflowDir = dir ?? WORKFLOWS_DIR;
  if (!existsSync(workflowDir)) return [];

  const files = readdirSync(workflowDir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
  const configs: WorkflowConfig[] = [];

  for (const file of files) {
    const content = readFileSync(`${workflowDir}/${file}`, "utf-8");
    const config = parseWorkflowYaml(content);
    if (config) configs.push(config);
  }

  return configs;
}

export function loadWorkflowByName(name: string, dir?: string): WorkflowConfig | null {
  const configs = loadWorkflowConfigs(dir);
  return configs.find(c => c.name === name) ?? null;
}
