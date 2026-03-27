/**
 * HITL Escalation Triggers — ELLIE-1079
 * Configurable pause-and-ask before risky actions.
 */

import { log } from "./logger.ts";

const logger = log.child("escalation");

export interface EscalationTrigger {
  type: "confidence_below" | "action_type" | "error_detected" | "cost_above";
  threshold?: number;
  actionTypes?: string[];
}

export interface EscalationCheck {
  triggered: boolean;
  trigger?: EscalationTrigger;
  reason?: string;
}

// Default triggers (can be overridden per creature in YAML)
export const DEFAULT_TRIGGERS: EscalationTrigger[] = [
  { type: "action_type", actionTypes: ["production_deploy", "delete_data", "send_email", "financial_transaction"] },
  { type: "confidence_below", threshold: 0.5 },
  { type: "cost_above", threshold: 2.0 },  // $2 per dispatch
];

/**
 * Check if any escalation trigger fires for the current context.
 */
export function checkEscalation(opts: {
  triggers?: EscalationTrigger[];
  actionType?: string;
  confidence?: number;
  estimatedCost?: number;
  errorDetected?: boolean;
}): EscalationCheck {
  const triggers = opts.triggers ?? DEFAULT_TRIGGERS;

  for (const trigger of triggers) {
    switch (trigger.type) {
      case "action_type":
        if (opts.actionType && trigger.actionTypes?.includes(opts.actionType)) {
          return {
            triggered: true,
            trigger,
            reason: `Action "${opts.actionType}" requires approval`,
          };
        }
        break;

      case "confidence_below":
        if (opts.confidence !== undefined && trigger.threshold !== undefined &&
            opts.confidence < trigger.threshold) {
          return {
            triggered: true,
            trigger,
            reason: `Confidence ${opts.confidence} below threshold ${trigger.threshold}`,
          };
        }
        break;

      case "cost_above":
        if (opts.estimatedCost !== undefined && trigger.threshold !== undefined &&
            opts.estimatedCost > trigger.threshold) {
          return {
            triggered: true,
            trigger,
            reason: `Estimated cost $${opts.estimatedCost.toFixed(2)} exceeds $${trigger.threshold} limit`,
          };
        }
        break;

      case "error_detected":
        if (opts.errorDetected) {
          return {
            triggered: true,
            trigger,
            reason: "Error detected — requesting human review",
          };
        }
        break;
    }
  }

  return { triggered: false };
}

/**
 * Parse escalation triggers from creature YAML frontmatter.
 */
export function parseTriggers(yaml: Record<string, unknown>[]): EscalationTrigger[] {
  return yaml.map(entry => {
    const trigger: EscalationTrigger = {
      type: (entry.type as string) || "action_type",
    };
    if (entry.threshold !== undefined) trigger.threshold = Number(entry.threshold);
    if (Array.isArray(entry.action_types)) trigger.actionTypes = entry.action_types as string[];
    return trigger;
  });
}
