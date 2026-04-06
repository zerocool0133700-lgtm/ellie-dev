/**
 * Forest Grove Management — ELLIE-818
 *
 * Manages grove (group) membership and access control for agents.
 * Groves are shared knowledge workspaces in the Forest.
 *
 * Key concepts:
 *   - Each agent has a personal tree + personal knowledge scope
 *   - Groves (groups) are shared workspaces with member agents
 *   - Grove membership controls read access to scoped knowledge
 *   - RBAC capabilities + grove membership control write access
 *   - Formations auto-create groves when spawned
 */

import { sql } from '../../ellie-forest/src/index'
import { log } from './logger.ts'

const logger = log.child('forest-grove')

// ── Types ────────────────────────────────────────────────────────

export interface GroveInfo {
  id: string
  name: string
  description: string | null
  scope_path: string | null
  metadata: Record<string, unknown>
}

export interface GroveMembership {
  group_id: string
  group_name: string
  person_id: string
  role: string
  access_level: string
}

export interface AgentGroveAccess {
  entity_id: string
  agent_name: string
  groves: GroveMembership[]
  personal_scope: string | null
}

// ── Agent entity resolution ──────────────────────────────────────

/**
 * Resolve a Forest entity_id from an agent name (archetype match).
 * Returns null if no matching RBAC entity found.
 */
export async function resolveAgentEntityId(agentName: string): Promise<string | null> {
  const rows = await sql`
    SELECT id FROM rbac_entities
    WHERE archetype = ${agentName} AND entity_type = 'agent'
    LIMIT 1
  `
  return rows[0]?.id ?? null
}

/**
 * Resolve a person_id (people table) from an RBAC entity_id.
 * The people table links to the entities table via entity_id.
 */
export async function resolvePersonId(entityId: string): Promise<string | null> {
  const rows = await sql`
    SELECT p.id FROM people p
    WHERE p.entity_id = ${entityId}
    LIMIT 1
  `
  return rows[0]?.id ?? null
}

// ── Grove membership queries ─────────────────────────────────────

/**
 * Get all groves an agent belongs to, with access levels.
 */
export async function getAgentGroves(entityId: string): Promise<GroveMembership[]> {
  const personId = await resolvePersonId(entityId)
  if (!personId) return []

  const rows = await sql`
    SELECT gm.group_id, g.name as group_name, gm.person_id,
           gm.role, gm.access_level
    FROM group_memberships gm
    JOIN groups g ON g.id = gm.group_id
    WHERE gm.person_id = ${personId}
    ORDER BY g.name
  `
  return rows as GroveMembership[]
}

/**
 * Get full grove access info for an agent (entity_id + groves + personal scope).
 */
export async function getAgentGroveAccess(agentName: string): Promise<AgentGroveAccess | null> {
  const entityId = await resolveAgentEntityId(agentName)
  if (!entityId) return null

  const groves = await getAgentGroves(entityId)

  // Get personal scope
  const [scope] = await sql`
    SELECT path FROM knowledge_scopes
    WHERE tree_id IN (
      SELECT tree_id FROM people WHERE entity_id = ${entityId}
    )
    LIMIT 1
  `

  return {
    entity_id: entityId,
    agent_name: agentName,
    groves,
    personal_scope: scope?.path ?? null,
  }
}

// ── Access control checks ────────────────────────────────────────

/**
 * Check if an agent has read access to a scope path via grove membership.
 *
 * Rules:
 *   - Agent can always read their own personal scope (3/<name>)
 *   - Agent can read scopes linked to groves they belong to
 *   - Agent can read child scopes of groves they belong to
 *   - Scope `3/org` (root grove) is readable by all org members
 */
export async function canAgentReadScope(
  entityId: string,
  scopePath: string,
): Promise<boolean> {
  const personId = await resolvePersonId(entityId)
  if (!personId) return false

  // Check personal scope access
  const [personalScope] = await sql`
    SELECT ks.path FROM knowledge_scopes ks
    JOIN people p ON p.tree_id = ks.tree_id
    WHERE p.entity_id = ${entityId}
  `
  if (personalScope && (scopePath === personalScope.path || scopePath.startsWith(personalScope.path + '/'))) {
    return true
  }

  // Check grove membership — does the scope belong to a grove the agent is in?
  const rows = await sql`
    SELECT 1 FROM group_memberships gm
    JOIN knowledge_scopes ks ON ks.group_id = gm.group_id
    WHERE gm.person_id = ${personId}
      AND (ks.path = ${scopePath} OR ${scopePath} LIKE ks.path || '/%')
    LIMIT 1
  `
  if (rows.length > 0) return true

  // Check if scope is a child of a grove-linked scope
  const groveRows = await sql`
    SELECT ks.path FROM knowledge_scopes ks
    JOIN group_memberships gm ON gm.group_id = ks.group_id
    WHERE gm.person_id = ${personId}
  `
  for (const row of groveRows) {
    if (scopePath === row.path || scopePath.startsWith(row.path + '/')) {
      return true
    }
  }

  return false
}

/**
 * Check if an agent has write access to a scope path.
 *
 * Write requires grove membership with 'write' or 'admin' access_level.
 * Personal scope always has write access.
 */
export async function canAgentWriteScope(
  entityId: string,
  scopePath: string,
): Promise<boolean> {
  const personId = await resolvePersonId(entityId)
  if (!personId) return false

  // Personal scope always writable
  const [personalScope] = await sql`
    SELECT ks.path FROM knowledge_scopes ks
    JOIN people p ON p.tree_id = ks.tree_id
    WHERE p.entity_id = ${entityId}
  `
  if (personalScope && (scopePath === personalScope.path || scopePath.startsWith(personalScope.path + '/'))) {
    return true
  }

  // Check grove membership with write access
  const rows = await sql`
    SELECT 1 FROM group_memberships gm
    JOIN knowledge_scopes ks ON ks.group_id = gm.group_id
    WHERE gm.person_id = ${personId}
      AND gm.access_level IN ('write', 'admin', 'full')
      AND (ks.path = ${scopePath} OR ${scopePath} LIKE ks.path || '/%')
    LIMIT 1
  `
  return rows.length > 0
}

// ── Formation grove management ───────────────────────────────────

/**
 * Create a grove for a formation and add all participating agents as members.
 * Returns the grove info, or null if it already exists.
 */
export async function createFormationGrove(
  formationName: string,
  sessionId: string,
  participatingAgents: string[],
): Promise<GroveInfo | null> {
  const sessionSlug = sessionId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 12)
  const groveName = `formation-${formationName}-${sessionSlug}`
  const scopePath = `2/formations/${formationName}/${sessionSlug}`

  try {
    // Create the grove (group)
    const [group] = await sql`
      INSERT INTO groups (name, description, metadata)
      VALUES (
        ${groveName},
        ${'Formation grove for ' + formationName},
        ${sql.json({ type: 'formation-grove', formation: formationName, session_id: sessionId })}
      )
      ON CONFLICT (name) DO NOTHING
      RETURNING id, name, description, metadata
    `

    if (!group) {
      // Already exists — look it up
      const [existing] = await sql`
        SELECT id, name, description, metadata FROM groups WHERE name = ${groveName}
      `
      if (existing) {
        return { ...existing, scope_path: scopePath } as GroveInfo
      }
      return null
    }

    // Create knowledge scope for the formation
    // First ensure parent path exists
    const formationParent = `2/formations`
    const [parentScope] = await sql`
      SELECT id FROM knowledge_scopes WHERE path = ${formationParent}
    `
    let parentId: string | null = null
    if (!parentScope) {
      const [newParent] = await sql`
        INSERT INTO knowledge_scopes (path, name, level, parent_id, description)
        VALUES (${formationParent}, 'Formations', 'topic',
          (SELECT id FROM knowledge_scopes WHERE path = '2'),
          'Formation-specific knowledge scopes')
        ON CONFLICT (path) DO NOTHING
        RETURNING id
      `
      parentId = newParent?.id ?? null
      if (!parentId) {
        const [existing] = await sql`SELECT id FROM knowledge_scopes WHERE path = ${formationParent}`
        parentId = existing?.id ?? null
      }
    } else {
      parentId = parentScope.id
    }

    // Create the formation-specific scope
    await sql`
      INSERT INTO knowledge_scopes (path, name, level, parent_id, group_id, description)
      VALUES (
        ${scopePath}, ${formationName}, 'grove', ${parentId}, ${group.id},
        ${'Knowledge scope for formation ' + formationName + ' session ' + sessionId.slice(0, 8)}
      )
      ON CONFLICT (path) DO NOTHING
    `

    // Track in formation_groves table
    await sql`
      INSERT INTO formation_groves (formation_name, session_id, group_id, scope_path)
      VALUES (${formationName}, ${sessionId}, ${group.id}, ${scopePath})
      ON CONFLICT (formation_name, session_id) DO NOTHING
    `

    // Add participating agents as members
    for (const agentName of participatingAgents) {
      const entityId = await resolveAgentEntityId(agentName)
      if (!entityId) continue
      const personId = await resolvePersonId(entityId)
      if (!personId) continue

      await sql`
        INSERT INTO group_memberships (group_id, person_id, role, access_level)
        VALUES (${group.id}, ${personId}, 'participant', 'write')
        ON CONFLICT (group_id, person_id) DO NOTHING
      `
    }

    logger.info(`Created formation grove: ${groveName} with ${participatingAgents.length} agents`)

    return {
      id: group.id,
      name: groveName,
      description: group.description,
      scope_path: scopePath,
      metadata: group.metadata,
    }
  } catch (err) {
    logger.error('Failed to create formation grove', err)
    return null
  }
}

/**
 * Look up an existing formation grove by formation name + session.
 */
export async function getFormationGrove(
  formationName: string,
  sessionId: string,
): Promise<GroveInfo | null> {
  const [row] = await sql`
    SELECT fg.group_id, fg.scope_path, g.name, g.description, g.metadata
    FROM formation_groves fg
    JOIN groups g ON g.id = fg.group_id
    WHERE fg.formation_name = ${formationName}
      AND fg.session_id = ${sessionId}
  `
  if (!row) return null
  return {
    id: row.group_id,
    name: row.name,
    description: row.description,
    scope_path: row.scope_path,
    metadata: row.metadata,
  }
}

// ── Testing helpers ──────────────────────────────────────────────

export { sql as _sql }
