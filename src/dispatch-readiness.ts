/**
 * Pre-dispatch readiness validation (ELLIE-1268)
 *
 * Two-tier system:
 *   Tier 1 — Lightweight (~50ms): synchronous, in-memory checks on WorkItemDetails
 *   Tier 2 — Deep validation (future): async checks with external calls
 *
 * Produces blockers (hard gate) and warnings (informational).
 * Strict mode promotes all warnings to blockers for autonomous/overnight dispatch.
 */

import type { WorkItemDetails } from "./plane.js";

// ============================================================
// TYPES
// ============================================================

export interface ReadinessIssue {
  rule: string;
  message: string;
}

export interface ReadinessResult {
  ready: boolean;
  blockers: ReadinessIssue[];
  warnings: ReadinessIssue[];
}

export interface ReadinessConfig {
  /** Minimum description length to pass (default: 20) */
  minDescriptionLength: number;
  /** Days since last update before "stale" warning (default: 30) */
  staleDaysThreshold: number;
  /** Promote all warnings to blockers (default: false) */
  strictMode: boolean;
}

// ============================================================
// DEFAULTS
// ============================================================

const DEFAULT_CONFIG: ReadinessConfig = {
  minDescriptionLength: 20,
  staleDaysThreshold: 30,
  strictMode: process.env.READINESS_STRICT_MODE === "true",
};

// ============================================================
// BLOCKER RULES
// ============================================================

type Rule = (details: WorkItemDetails, config: ReadinessConfig) => ReadinessIssue | null;

const blockerRules: Rule[] = [
  // 1. Ticket is already done or cancelled
  (details) => {
    const group = details.stateGroup?.toLowerCase();
    if (group === "completed" || group === "cancelled") {
      return {
        rule: "state_terminal",
        message: `Ticket is in terminal state: ${group}`,
      };
    }
    return null;
  },

  // 2. Description is empty or too short
  (details, config) => {
    const desc = details.description.trim();
    if (desc.length === 0) {
      return {
        rule: "description_empty",
        message: "Ticket has no description",
      };
    }
    if (desc.length < config.minDescriptionLength) {
      return {
        rule: "description_too_short",
        message: `Description is only ${desc.length} chars (minimum: ${config.minDescriptionLength})`,
      };
    }
    return null;
  },

  // 3. Title-only ticket — description is just the title repeated
  (details) => {
    const desc = details.description.trim().toLowerCase();
    const title = details.name.trim().toLowerCase();
    if (desc.length > 0 && desc === title) {
      return {
        rule: "description_matches_title",
        message: "Description is identical to the title — no actionable detail",
      };
    }
    return null;
  },

  // 4. Urgent/high priority without estimate
  (details) => {
    const highPriorities = ["urgent", "high"];
    if (highPriorities.includes(details.priority) && details.estimatePoint == null) {
      return {
        rule: "high_priority_no_estimate",
        message: `${details.priority} priority ticket has no estimate — scope is unclear`,
      };
    }
    return null;
  },
];

// ============================================================
// WARNING RULES
// ============================================================

const warningRules: Rule[] = [
  // 1. No estimate
  (details) => {
    if (details.estimatePoint == null) {
      return {
        rule: "no_estimate",
        message: "No estimate point set — effort is unknown",
      };
    }
    return null;
  },

  // 2. No assignee
  (details) => {
    if (details.assignees.length === 0) {
      return {
        rule: "no_assignee",
        message: "No assignee — ownership is unclear",
      };
    }
    return null;
  },

  // 3. Target date in the past
  (details) => {
    if (details.targetDate) {
      const target = new Date(details.targetDate);
      const now = new Date();
      // Compare date-only (ignore time)
      target.setHours(0, 0, 0, 0);
      now.setHours(0, 0, 0, 0);
      if (target < now) {
        return {
          rule: "target_date_past",
          message: `Target date ${details.targetDate} is in the past`,
        };
      }
    }
    return null;
  },

  // 4. Stale ticket — not updated recently
  (details, config) => {
    if (details.updatedAt) {
      const updated = new Date(details.updatedAt);
      const now = new Date();
      const daysSinceUpdate = Math.floor((now.getTime() - updated.getTime()) / (1000 * 60 * 60 * 24));
      if (daysSinceUpdate > config.staleDaysThreshold) {
        return {
          rule: "stale_ticket",
          message: `Ticket not updated in ${daysSinceUpdate} days (threshold: ${config.staleDaysThreshold})`,
        };
      }
    }
    return null;
  },
];

// ============================================================
// MAIN VALIDATION
// ============================================================

/**
 * Run Tier 1 readiness checks against a work item.
 * Synchronous, in-memory only — no external calls.
 *
 * @param details - The fetched work item details
 * @param configOverrides - Optional config overrides (merged with defaults + env)
 * @returns ReadinessResult with blockers, warnings, and ready flag
 */
export function checkReadiness(
  details: WorkItemDetails,
  configOverrides?: Partial<ReadinessConfig>,
): ReadinessResult {
  const config: ReadinessConfig = { ...DEFAULT_CONFIG, ...configOverrides };

  const blockers: ReadinessIssue[] = [];
  const warnings: ReadinessIssue[] = [];

  // Run blocker rules
  for (const rule of blockerRules) {
    const issue = rule(details, config);
    if (issue) blockers.push(issue);
  }

  // Run warning rules
  for (const rule of warningRules) {
    const issue = rule(details, config);
    if (issue) {
      if (config.strictMode) {
        blockers.push(issue);
      } else {
        warnings.push(issue);
      }
    }
  }

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
  };
}

/**
 * Format a ReadinessResult into a human-readable summary for notifications.
 */
export function formatReadinessResult(result: ReadinessResult, workItemId: string): string {
  if (result.ready && result.warnings.length === 0) {
    return `${workItemId}: all readiness checks passed`;
  }

  const lines: string[] = [];

  if (!result.ready) {
    lines.push(`${workItemId} dispatch BLOCKED:`);
    for (const b of result.blockers) {
      lines.push(`  [BLOCKER] ${b.message}`);
    }
  }

  if (result.warnings.length > 0) {
    if (result.ready) lines.push(`${workItemId} readiness warnings:`);
    for (const w of result.warnings) {
      lines.push(`  [WARNING] ${w.message}`);
    }
  }

  return lines.join("\n");
}
