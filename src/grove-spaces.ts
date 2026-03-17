/**
 * Grove Collaborative Spaces — ELLIE-824, ELLIE-825, ELLIE-827, ELLIE-829
 *
 * Manages shared Grove directory structure and per-role access policies.
 * Grove is the team library — finished, vetted knowledge lives here.
 */

import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { sql } from "../../ellie-forest/src/index";
import { canAgentWriteScope, resolveAgentEntityId, resolvePersonId } from "./forest-grove.ts";
import { log } from "./logger.ts";

const logger = log.child("grove-spaces");

const RIVER_BASE = process.env.RIVER_BASE ?? "/home/ellie/obsidian-vault/ellie-river";

// ── ELLIE-824: Grove directory structure ─────────────────────────

/** All collaborative grove spaces. */
export const GROVE_SPACES = [
  "requirements",
  "codebase",
  "design-specs",
  "design-system",
  "accessibility",
  "reviews",
  "risk-registry",
  "post-mortems",
  "test-results",
  "bug-reports",
  "test-coverage",
  "client-context",
  "handoffs",
  "work-trails",
  "technical-debt",
] as const;

export type GroveSpace = typeof GROVE_SPACES[number];

// ── ELLIE-825: Per-role access matrix ────────────────────────────

/** Access matrix: agent → grove space → access level */
export type AccessLevel = "read" | "write" | "none";

export interface GroveAccessRule {
  agent: string;
  space: GroveSpace;
  access: AccessLevel;
}

/**
 * Role-based access matrix for Grove spaces.
 * Agents not listed default to "read" for spaces in their readable list.
 */
const WRITE_ACCESS: Record<string, GroveSpace[]> = {
  research:  ["requirements", "client-context", "handoffs"],
  dev:       ["codebase", "work-trails", "technical-debt"],
  critic:    ["reviews", "risk-registry", "post-mortems"],
  content:   ["design-specs", "design-system", "accessibility"],
  strategy:  ["requirements", "client-context"],
  finance:   ["requirements"],
  general:   [],
  ops:       ["codebase", "technical-debt"],
};

/** ELLIE-827: Agents with broad-read access across ALL grove spaces. */
const BROAD_READ_AGENTS = new Set(["critic"]);

/**
 * Determine access level for an agent to a grove space.
 */
export function getGroveAccess(agent: string, space: GroveSpace): AccessLevel {
  const writeSpaces = WRITE_ACCESS[agent];
  if (writeSpaces?.includes(space)) return "write";

  // ELLIE-827: Critic gets read everywhere
  if (BROAD_READ_AGENTS.has(agent)) return "read";

  // Default: all agents can read all spaces (knowledge sharing)
  return "read";
}

/**
 * Get full access matrix for an agent.
 */
export function getAgentGroveMatrix(agent: string): GroveAccessRule[] {
  return GROVE_SPACES.map(space => ({
    agent,
    space,
    access: getGroveAccess(agent, space),
  }));
}

/**
 * Get all agents with write access to a grove space.
 */
export function getWriters(space: GroveSpace): string[] {
  return Object.entries(WRITE_ACCESS)
    .filter(([_, spaces]) => spaces.includes(space))
    .map(([agent]) => agent);
}

/**
 * Check if an agent can write to a grove space (pure check, no DB).
 */
export function canWriteGroveSpace(agent: string, space: GroveSpace): boolean {
  return getGroveAccess(agent, space) === "write";
}

/**
 * Check if an agent can read a grove space (pure check, no DB).
 */
export function canReadGroveSpace(agent: string, space: GroveSpace): boolean {
  const access = getGroveAccess(agent, space);
  return access === "read" || access === "write";
}

// ── ELLIE-824: Grove provisioning ────────────────────────────────

/**
 * Create the Grove directory structure in the River vault.
 * Also creates knowledge_scopes entries for each space.
 */
export async function provisionGrove(baseDir?: string): Promise<{ spaces: string[]; scopesCreated: number }> {
  const base = baseDir ?? RIVER_BASE;
  const groveDir = join(base, "grove");
  let scopesCreated = 0;

  // Ensure parent scope exists
  const parentPath = "2/grove";
  await sql`
    INSERT INTO knowledge_scopes (path, name, level, parent_id, description)
    VALUES (${parentPath}, 'Grove', 'topic',
      (SELECT id FROM knowledge_scopes WHERE path = '2'),
      'Collaborative knowledge spaces')
    ON CONFLICT (path) DO NOTHING
  `;

  const [parent] = await sql`SELECT id FROM knowledge_scopes WHERE path = ${parentPath}`;

  for (const space of GROVE_SPACES) {
    const spaceDir = join(groveDir, space);
    if (!existsSync(spaceDir)) {
      mkdirSync(spaceDir, { recursive: true });
    }

    // Create knowledge scope
    const scopePath = `2/grove/${space}`;
    const [inserted] = await sql`
      INSERT INTO knowledge_scopes (path, name, level, parent_id, description)
      VALUES (${scopePath}, ${space}, 'grove', ${parent?.id ?? null}, ${'Grove space: ' + space})
      ON CONFLICT (path) DO NOTHING
      RETURNING id
    `;
    if (inserted) scopesCreated++;
  }

  return { spaces: [...GROVE_SPACES], scopesCreated };
}

// ── ELLIE-825: DB-backed grove RBAC ──────────────────────────────

/**
 * Register grove RBAC permissions in the database.
 * Creates grove.read and grove.write permissions with scope per space.
 */
export async function seedGrovePermissions(): Promise<number> {
  let count = 0;

  for (const space of GROVE_SPACES) {
    // Create read permission for each space
    await sql`
      INSERT INTO rbac_permissions (resource, action, scope, description)
      VALUES ('grove', 'read', ${'grove:' + space}, ${'Read access to grove/' + space})
      ON CONFLICT (resource, action, scope) DO NOTHING
    `;

    // Create write permission for each space
    await sql`
      INSERT INTO rbac_permissions (resource, action, scope, description)
      VALUES ('grove', 'write', ${'grove:' + space}, ${'Write access to grove/' + space})
      ON CONFLICT (resource, action, scope) DO NOTHING
    `;
    count += 2;
  }

  return count;
}

// ── ELLIE-829: Formation grove override ──────────────────────────

/**
 * Grant temporary write access to all formation participants for a grove.
 * Overrides normal RBAC — all members get write access during the formation.
 */
export async function grantFormationAccess(
  groupId: string,
  agents: string[],
): Promise<number> {
  let granted = 0;

  for (const agent of agents) {
    const entityId = await resolveAgentEntityId(agent);
    if (!entityId) continue;
    const personId = await resolvePersonId(entityId);
    if (!personId) continue;

    await sql`
      INSERT INTO group_memberships (group_id, person_id, role, access_level)
      VALUES (${groupId}, ${personId}, 'participant', 'write')
      ON CONFLICT (group_id, person_id)
      DO UPDATE SET access_level = 'write', role = 'participant'
    `;
    granted++;
  }

  return granted;
}

/**
 * Revoke formation override — revert access to normal RBAC.
 * Sets all formation participants back to 'read' access.
 */
export async function revokeFormationAccess(groupId: string): Promise<number> {
  const result = await sql`
    UPDATE group_memberships
    SET access_level = 'read', role = 'member'
    WHERE group_id = ${groupId} AND role = 'participant'
  `;
  return result.count;
}
