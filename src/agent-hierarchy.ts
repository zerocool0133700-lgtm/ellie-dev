/**
 * Agent Org Chart Hierarchy — ELLIE-725
 *
 * Reporting lines, hierarchy queries (recursive CTE), and
 * circular reference validation for agent org charts.
 *
 * Database functions module — uses postgres.js via ellie-forest.
 */

import { sql } from "../../ellie-forest/src/index";

// ── Types ────────────────────────────────────────────────────

/** An agent with hierarchy fields (subset of full agent record). */
export interface AgentNode {
  id: string;
  name: string;
  type: string;
  title: string | null;
  reports_to: string | null;
  status: string;
}

/** A node in a materialized org tree with depth and children. */
export interface OrgTreeNode extends AgentNode {
  depth: number;
  children: OrgTreeNode[];
}

/** A flat row from the recursive CTE walk. */
export interface HierarchyRow extends AgentNode {
  depth: number;
}

// ── Set Reporting Line ──────────────────────────────────────

/**
 * Set an agent's reporting line (who they report to).
 * The database trigger prevents circular references.
 */
export async function setReportsTo(
  agentId: string,
  reportsTo: string | null,
): Promise<AgentNode> {
  const [agent] = await sql<AgentNode[]>`
    UPDATE agents
    SET reports_to = ${reportsTo}::uuid, updated_at = NOW()
    WHERE id = ${agentId}::uuid
    RETURNING id, name, type, title, reports_to, status
  `;

  if (!agent) {
    throw new Error(`Agent ${agentId} not found`);
  }

  return agent;
}

/**
 * Set an agent's title.
 */
export async function setTitle(
  agentId: string,
  title: string | null,
): Promise<AgentNode> {
  const [agent] = await sql<AgentNode[]>`
    UPDATE agents
    SET title = ${title}, updated_at = NOW()
    WHERE id = ${agentId}::uuid
    RETURNING id, name, type, title, reports_to, status
  `;

  if (!agent) {
    throw new Error(`Agent ${agentId} not found`);
  }

  return agent;
}

// ── Hierarchy Queries ───────────────────────────────────────

/**
 * Get the full subtree under an agent (recursive CTE walk down).
 * Returns flat rows with depth — use buildOrgTree() to nest.
 */
export async function getSubtree(rootId: string): Promise<HierarchyRow[]> {
  return sql<HierarchyRow[]>`
    WITH RECURSIVE subtree AS (
      SELECT id, name, type, title, reports_to, status, 0 AS depth
      FROM agents
      WHERE id = ${rootId}::uuid

      UNION ALL

      SELECT a.id, a.name, a.type, a.title, a.reports_to, a.status, s.depth + 1
      FROM agents a
      INNER JOIN subtree s ON a.reports_to = s.id
    )
    SELECT * FROM subtree
    ORDER BY depth, name
  `;
}

/**
 * Get the chain of command from an agent up to the root.
 * Returns rows from the agent up to the CEO (root).
 */
export async function getChainOfCommand(agentId: string): Promise<HierarchyRow[]> {
  return sql<HierarchyRow[]>`
    WITH RECURSIVE chain AS (
      SELECT id, name, type, title, reports_to, status, 0 AS depth
      FROM agents
      WHERE id = ${agentId}::uuid

      UNION ALL

      SELECT a.id, a.name, a.type, a.title, a.reports_to, a.status, c.depth + 1
      FROM agents a
      INNER JOIN chain c ON a.id = c.reports_to
    )
    SELECT * FROM chain
    ORDER BY depth
  `;
}

/**
 * Get direct reports for an agent.
 */
export async function getDirectReports(agentId: string): Promise<AgentNode[]> {
  return sql<AgentNode[]>`
    SELECT id, name, type, title, reports_to, status
    FROM agents
    WHERE reports_to = ${agentId}::uuid
    ORDER BY name
  `;
}

/**
 * Get root agents (no reports_to — the top of the org chart).
 * Optionally filter by company_id.
 */
export async function getRootAgents(companyId?: string): Promise<AgentNode[]> {
  if (companyId) {
    return sql<AgentNode[]>`
      SELECT id, name, type, title, reports_to, status
      FROM agents
      WHERE reports_to IS NULL AND company_id = ${companyId}::uuid
      ORDER BY name
    `;
  }

  return sql<AgentNode[]>`
    SELECT id, name, type, title, reports_to, status
    FROM agents
    WHERE reports_to IS NULL
    ORDER BY name
  `;
}

/**
 * Get the full org tree for a company. Starts from root agents
 * and walks down recursively.
 */
export async function getOrgTree(companyId?: string): Promise<HierarchyRow[]> {
  if (companyId) {
    return sql<HierarchyRow[]>`
      WITH RECURSIVE org AS (
        SELECT id, name, type, title, reports_to, status, 0 AS depth
        FROM agents
        WHERE reports_to IS NULL AND company_id = ${companyId}::uuid

        UNION ALL

        SELECT a.id, a.name, a.type, a.title, a.reports_to, a.status, o.depth + 1
        FROM agents a
        INNER JOIN org o ON a.reports_to = o.id
      )
      SELECT * FROM org
      ORDER BY depth, name
    `;
  }

  return sql<HierarchyRow[]>`
    WITH RECURSIVE org AS (
      SELECT id, name, type, title, reports_to, status, 0 AS depth
      FROM agents
      WHERE reports_to IS NULL

      UNION ALL

      SELECT a.id, a.name, a.type, a.title, a.reports_to, a.status, o.depth + 1
      FROM agents a
      INNER JOIN org o ON a.reports_to = o.id
    )
    SELECT * FROM org
    ORDER BY depth, name
  `;
}

// ── Tree Building (Pure) ────────────────────────────────────

/**
 * Build a nested org tree from flat hierarchy rows.
 * Pure function — no database calls.
 */
export function buildOrgTree(rows: HierarchyRow[]): OrgTreeNode[] {
  const nodeMap = new Map<string, OrgTreeNode>();

  // Create nodes
  for (const row of rows) {
    nodeMap.set(row.id, { ...row, children: [] });
  }

  // Link children to parents
  const roots: OrgTreeNode[] = [];
  for (const node of nodeMap.values()) {
    if (node.reports_to && nodeMap.has(node.reports_to)) {
      nodeMap.get(node.reports_to)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

/**
 * Validate that setting reports_to would not create a cycle.
 * Pure function — walks the provided rows in memory.
 *
 * The database trigger also prevents this, but this function
 * allows pre-validation without hitting the DB.
 */
export function wouldCreateCycle(
  agentId: string,
  newReportsTo: string,
  agents: Pick<AgentNode, "id" | "reports_to">[],
): boolean {
  if (agentId === newReportsTo) return true;

  const parentMap = new Map(agents.map(a => [a.id, a.reports_to]));
  // Temporarily set the new relationship
  parentMap.set(agentId, newReportsTo);

  // Walk from agentId up the chain
  let current: string | null | undefined = newReportsTo;
  const visited = new Set<string>();
  visited.add(agentId);

  while (current) {
    if (visited.has(current)) return true;
    visited.add(current);
    current = parentMap.get(current) ?? null;
  }

  return false;
}

/**
 * Flatten an org tree back to a list of hierarchy rows.
 * Useful for serialisation.
 */
export function flattenOrgTree(roots: OrgTreeNode[]): HierarchyRow[] {
  const result: HierarchyRow[] = [];

  function walk(node: OrgTreeNode) {
    const { children, ...row } = node;
    result.push(row);
    for (const child of children) {
      walk(child);
    }
  }

  for (const root of roots) {
    walk(root);
  }

  return result;
}
