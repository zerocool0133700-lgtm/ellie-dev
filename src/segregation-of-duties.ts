/**
 * Segregation of Duties — ELLIE-1076
 * Enforces that maker cannot approve own work.
 * Conflict matrix prevents role overlap (dev can't be critic for same work).
 */

import { log } from "./logger.ts";

const logger = log.child("sod");

// Role definitions
export type SODRole = "maker" | "reviewer" | "approver" | "auditor";

// Default conflict matrix: which roles cannot be held by same creature for same work item
export const CONFLICT_MATRIX: [SODRole, SODRole][] = [
  ["maker", "reviewer"],    // Author can't review own work
  ["maker", "approver"],    // Author can't approve own work
  ["maker", "auditor"],     // Author can't audit own work
  ["reviewer", "approver"], // Reviewer can't also approve (double-sign)
];

// Map agent archetypes to SOD roles
export const ARCHETYPE_ROLES: Record<string, SODRole[]> = {
  dev:      ["maker"],
  research: ["maker"],
  content:  ["maker"],
  critic:   ["reviewer", "auditor"],
  strategy: ["approver"],
  ops:      ["maker", "auditor"],
  finance:  ["auditor"],
  general:  ["approver"],
};

export interface SODCheck {
  allowed: boolean;
  reason?: string;
  conflicts?: string[];
}

/**
 * Check if a creature can perform a role on a work item,
 * given who else has acted on it.
 */
export function checkSOD(opts: {
  creature: string;
  role: SODRole;
  workItemId: string;
  priorActors: Array<{ creature: string; role: SODRole }>;
}): SODCheck {
  const { creature, role, priorActors } = opts;
  const conflicts: string[] = [];

  for (const prior of priorActors) {
    if (prior.creature !== creature) continue;

    // Same creature, different role — check conflict matrix
    for (const [roleA, roleB] of CONFLICT_MATRIX) {
      if ((prior.role === roleA && role === roleB) ||
          (prior.role === roleB && role === roleA)) {
        conflicts.push(`${creature} cannot be both ${prior.role} and ${role} on ${opts.workItemId}`);
      }
    }
  }

  if (conflicts.length > 0) {
    logger.warn("SOD violation blocked", { creature, role, workItemId: opts.workItemId, conflicts });
    return { allowed: false, reason: conflicts[0], conflicts };
  }

  return { allowed: true };
}

/**
 * Get allowed roles for a creature based on its archetype.
 */
export function getAllowedRoles(archetype: string): SODRole[] {
  return ARCHETYPE_ROLES[archetype.toLowerCase()] ?? ["maker"];
}

/**
 * Validate that an archetype can perform a role.
 */
export function canPerformRole(archetype: string, role: SODRole): boolean {
  const allowed = getAllowedRoles(archetype);
  return allowed.includes(role);
}
