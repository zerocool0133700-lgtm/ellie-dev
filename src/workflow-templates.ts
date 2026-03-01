/**
 * Workflow Templates — ELLIE-388
 *
 * Loads predefined workflow definitions from config/workflows/*.yaml
 * and matches user messages against trigger phrases. When matched,
 * returns pipeline steps for the orchestration engine.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { log } from "./logger.ts";
import type { ExecutionMode } from "./intent-classifier.ts";

const logger = log.child("workflows");

// ── Types ──────────────────────────────────────────────────

export interface WorkflowStep {
  agent: string;
  skill: string;
  instruction: string;
}

export interface WorkflowTemplate {
  name: string;
  description: string;
  triggers: string[];
  mode: ExecutionMode;
  steps: WorkflowStep[];
}

export interface WorkflowMatch {
  workflow: WorkflowTemplate;
  trigger: string;
  confidence: number;
}

// ── Loading ────────────────────────────────────────────────

const WORKFLOWS_DIR = join(import.meta.dir, "..", "config", "workflows");
let _templates: WorkflowTemplate[] = [];
let _loaded = false;

/**
 * Parse a simple YAML workflow file.
 * Handles flat keys, string arrays, and array-of-object steps.
 */
function parseWorkflowYaml(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = raw.split("\n");
  let currentKey = "";
  let currentArray: unknown[] = [];
  let inSteps = false;
  let currentStep: Record<string, string> = {};

  for (const line of lines) {
    // Skip blank lines and comments
    if (!line.trim() || line.trim().startsWith("#")) continue;

    // Top-level key
    const topMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (topMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
      // Flush previous array/steps
      if (currentKey && currentArray.length > 0) {
        result[currentKey] = currentArray;
        currentArray = [];
      }
      if (inSteps && Object.keys(currentStep).length > 0) {
        currentArray.push({ ...currentStep });
        currentStep = {};
      }
      if (inSteps) {
        result[currentKey] = currentArray;
        currentArray = [];
        inSteps = false;
      }

      currentKey = topMatch[1];
      const val = topMatch[2].trim();
      if (val && !val.startsWith("[")) {
        result[currentKey] = val;
        currentKey = "";
      } else if (val.startsWith("[") && val.endsWith("]")) {
        // Inline array: [a, b, c]
        result[currentKey] = val.slice(1, -1).split(",").map(s => s.trim());
        currentKey = "";
      }
      if (currentKey === "steps") inSteps = true;
      continue;
    }

    // Array item (- value)
    const arrayMatch = line.match(/^\s+-\s+(.*)/);
    if (arrayMatch && !inSteps) {
      currentArray.push(arrayMatch[1].trim());
      continue;
    }

    // Steps: new step item
    if (inSteps && arrayMatch) {
      // Flush previous step
      if (Object.keys(currentStep).length > 0) {
        currentArray.push({ ...currentStep });
        currentStep = {};
      }
      // Parse "- agent: dev" style
      const kvMatch = arrayMatch[1].match(/^(\w+):\s*"?(.*?)"?\s*$/);
      if (kvMatch) {
        currentStep[kvMatch[1]] = kvMatch[2];
      }
      continue;
    }

    // Steps: continuation key
    if (inSteps) {
      const kvMatch = line.match(/^\s+(\w+):\s*"?(.*?)"?\s*$/);
      if (kvMatch) {
        currentStep[kvMatch[1]] = kvMatch[2];
      }
    }
  }

  // Flush remaining
  if (inSteps && Object.keys(currentStep).length > 0) {
    currentArray.push({ ...currentStep });
  }
  if (currentKey && currentArray.length > 0) {
    result[currentKey] = currentArray;
  }

  return result;
}

export function loadWorkflowTemplates(): WorkflowTemplate[] {
  try {
    const files = readdirSync(WORKFLOWS_DIR).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
    _templates = [];

    for (const file of files) {
      try {
        const raw = readFileSync(join(WORKFLOWS_DIR, file), "utf-8");
        const parsed = parseWorkflowYaml(raw);

        const template: WorkflowTemplate = {
          name: String(parsed.name || file.replace(/\.ya?ml$/, "")),
          description: String(parsed.description || ""),
          triggers: Array.isArray(parsed.triggers) ? parsed.triggers.map(String) : [],
          mode: (String(parsed.mode || "pipeline")) as ExecutionMode,
          steps: Array.isArray(parsed.steps)
            ? (parsed.steps as Record<string, string>[]).map(s => ({
                agent: s.agent || "general",
                skill: s.skill || "none",
                instruction: s.instruction || "",
              }))
            : [],
        };

        if (template.steps.length > 0) {
          _templates.push(template);
        } else {
          logger.warn(`Skipping workflow ${file} — no steps defined`);
        }
      } catch (err) {
        logger.error(`Failed to parse workflow ${file}`, err);
      }
    }

    _loaded = true;
    logger.info(`Loaded ${_templates.length} workflow templates`);
    return _templates;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      logger.info("No workflows directory found — skipping");
    } else {
      logger.error("Failed to load workflows", err);
    }
    _templates = [];
    _loaded = true;
    return _templates;
  }
}

// ── Matching ───────────────────────────────────────────────

/**
 * Match a user message against workflow trigger phrases.
 * Uses substring matching with word boundaries for robustness.
 */
export function matchWorkflow(message: string): WorkflowMatch | null {
  if (!_loaded) loadWorkflowTemplates();

  const lower = message.toLowerCase();

  for (const workflow of _templates) {
    for (const trigger of workflow.triggers) {
      const triggerLower = trigger.toLowerCase();
      // Check if the trigger phrase appears in the message
      if (lower.includes(triggerLower)) {
        return {
          workflow,
          trigger,
          confidence: 0.9,
        };
      }
    }
  }

  return null;
}

/**
 * Get all available workflow templates (for listing).
 */
export function getWorkflowTemplates(): WorkflowTemplate[] {
  if (!_loaded) loadWorkflowTemplates();
  return _templates;
}
