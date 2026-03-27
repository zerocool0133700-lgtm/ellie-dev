/**
 * Per-Step Model Routing — ELLIE-1080
 * Route different models per workflow step.
 * Classification → Haiku, Implementation → Opus, Review → Sonnet.
 */

import { log } from "./logger.ts";

const logger = log.child("step-model-router");

export interface ModelStylesheet {
  rules: ModelRule[];
  default: string;
}

export interface ModelRule {
  match: string;  // Step ID pattern (supports * wildcard)
  model: string;
  reasoning_effort?: "low" | "medium" | "high";
}

// Default stylesheet
export const DEFAULT_STYLESHEET: ModelStylesheet = {
  default: "sonnet",
  rules: [
    { match: "classify*", model: "haiku", reasoning_effort: "low" },
    { match: "lint*", model: "haiku", reasoning_effort: "low" },
    { match: "validate*", model: "haiku", reasoning_effort: "low" },
    { match: "implement*", model: "opus", reasoning_effort: "high" },
    { match: "architect*", model: "opus", reasoning_effort: "high" },
    { match: "review*", model: "sonnet", reasoning_effort: "medium" },
    { match: "test*", model: "sonnet", reasoning_effort: "medium" },
    { match: "summarize*", model: "haiku", reasoning_effort: "low" },
  ],
};

/**
 * Resolve model for a workflow step.
 * Checks stylesheet rules in order, first match wins.
 */
export function resolveStepModel(
  stepId: string,
  stepModel?: string,  // Explicit model override in step definition
  stylesheet?: ModelStylesheet
): { model: string; reasoning_effort?: string } {
  // Explicit step-level override takes priority
  if (stepModel) {
    return { model: stepModel };
  }

  const ss = stylesheet ?? DEFAULT_STYLESHEET;

  for (const rule of ss.rules) {
    if (matchPattern(rule.match, stepId)) {
      return { model: rule.model, reasoning_effort: rule.reasoning_effort };
    }
  }

  return { model: ss.default };
}

/**
 * Match a pattern against a step ID.
 * Supports * wildcard at end.
 */
function matchPattern(pattern: string, stepId: string): boolean {
  if (pattern.endsWith("*")) {
    return stepId.startsWith(pattern.slice(0, -1));
  }
  return pattern === stepId;
}

/**
 * Parse a stylesheet from YAML config.
 */
export function parseStylesheet(config: Record<string, unknown>): ModelStylesheet {
  const rules: ModelRule[] = [];
  const defaultModel = (config.default as string) || "sonnet";

  if (Array.isArray(config.rules)) {
    for (const rule of config.rules as Record<string, unknown>[]) {
      rules.push({
        match: (rule.match as string) || "*",
        model: (rule.model as string) || defaultModel,
        reasoning_effort: rule.reasoning_effort as ModelRule["reasoning_effort"],
      });
    }
  }

  return { rules, default: defaultModel };
}
