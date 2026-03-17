/**
 * Permission Guard — ELLIE-794
 * Middleware layer that checks permissions before agent dispatch,
 * tool execution, and work session operations.
 * Pure functions with injected dependencies for testability.
 */

import { canEntityDo, checkPermissionPure, type Role, type Permission } from "./permissions.ts";

// Types

export interface PermissionDenial {
  entity_id: string;
  entity_name?: string;
  resource: string;
  action: string;
  scope?: string;
  reason: string;
  timestamp: string;
}

export interface GuardResult {
  allowed: boolean;
  denial?: PermissionDenial;
}

export interface GuardConfig {
  enabled: boolean;
  log_denials: boolean;
  enforce: boolean; // false = log-only mode (audit without blocking)
}

export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  enabled: true,
  log_denials: true,
  enforce: true,
};

// Denial log (in-memory, recent denials for debugging)
const denialLog: PermissionDenial[] = [];
const MAX_DENIAL_LOG = 100;

function logDenial(denial: PermissionDenial): void {
  denialLog.push(denial);
  if (denialLog.length > MAX_DENIAL_LOG) {
    denialLog.shift();
  }
}

export function getRecentDenials(limit: number = 20): PermissionDenial[] {
  return denialLog.slice(-limit);
}

export function clearDenialLog(): void {
  denialLog.length = 0;
}

// Agent dispatch resource mapping

const AGENT_RESOURCE_MAP: Record<string, { resource: string; action: string }[]> = {
  dev: [
    { resource: "tools", action: "use_bash" },
    { resource: "tools", action: "use_edit" },
    { resource: "git", action: "commit" },
    { resource: "plane", action: "update_issue" },
  ],
  critic: [
    { resource: "plane", action: "read_issue" },
    { resource: "plane", action: "comment" },
  ],
  research: [
    { resource: "tools", action: "use_web" },
    { resource: "tools", action: "use_mcp" },
  ],
  general: [
    { resource: "messages", action: "send" },
    { resource: "memory", action: "read" },
  ],
  strategy: [
    { resource: "plane", action: "read_issue" },
    { resource: "forest", action: "read" },
  ],
  content: [
    { resource: "messages", action: "send" },
    { resource: "forest", action: "write" },
  ],
  finance: [
    { resource: "plane", action: "read_issue" },
    { resource: "tools", action: "use_mcp" },
  ],
};

export function getRequiredPermissions(agentName: string): { resource: string; action: string }[] {
  return AGENT_RESOURCE_MAP[agentName] ?? AGENT_RESOURCE_MAP.general;
}

// Tool execution resource mapping

const TOOL_PERMISSION_MAP: Record<string, { resource: string; action: string }> = {
  bash: { resource: "tools", action: "use_bash" },
  edit: { resource: "tools", action: "use_edit" },
  write: { resource: "tools", action: "use_edit" },
  read: { resource: "forest", action: "read" },
  web_search: { resource: "tools", action: "use_web" },
  web_fetch: { resource: "tools", action: "use_web" },
  mcp: { resource: "tools", action: "use_mcp" },
};

export function getToolPermission(toolName: string): { resource: string; action: string } | null {
  // Check direct mapping
  if (toolName in TOOL_PERMISSION_MAP) return TOOL_PERMISSION_MAP[toolName];
  // MCP tools start with mcp__
  if (toolName.startsWith("mcp__")) return { resource: "tools", action: "use_mcp" };
  return null;
}

// Guard checks

export async function guardAgentDispatch(
  sql: any,
  entityId: string,
  agentName: string,
  config: GuardConfig = DEFAULT_GUARD_CONFIG,
): Promise<GuardResult> {
  if (!config.enabled) return { allowed: true };

  const required = getRequiredPermissions(agentName);

  for (const { resource, action } of required) {
    const allowed = await canEntityDo(sql, entityId, resource, action);
    if (!allowed) {
      const denial: PermissionDenial = {
        entity_id: entityId,
        resource,
        action,
        reason: `Agent "${agentName}" requires ${resource}.${action} which entity lacks`,
        timestamp: new Date().toISOString(),
      };
      if (config.log_denials) logDenial(denial);
      if (config.enforce) return { allowed: false, denial };
    }
  }

  return { allowed: true };
}

export async function guardToolExecution(
  sql: any,
  entityId: string,
  toolName: string,
  config: GuardConfig = DEFAULT_GUARD_CONFIG,
): Promise<GuardResult> {
  if (!config.enabled) return { allowed: true };

  const perm = getToolPermission(toolName);
  if (!perm) return { allowed: true }; // Unknown tools pass through (read-only tools etc.)

  const allowed = await canEntityDo(sql, entityId, perm.resource, perm.action);
  if (!allowed) {
    const denial: PermissionDenial = {
      entity_id: entityId,
      resource: perm.resource,
      action: perm.action,
      reason: `Tool "${toolName}" requires ${perm.resource}.${perm.action}`,
      timestamp: new Date().toISOString(),
    };
    if (config.log_denials) logDenial(denial);
    if (config.enforce) return { allowed: false, denial };
  }

  return { allowed: true };
}

export async function guardWorkSession(
  sql: any,
  entityId: string,
  operation: "start" | "update" | "complete",
  config: GuardConfig = DEFAULT_GUARD_CONFIG,
): Promise<GuardResult> {
  if (!config.enabled) return { allowed: true };

  // Work sessions require plane.update_issue for start/complete, plane.read_issue for update
  const action = operation === "update" ? "read_issue" : "update_issue";
  const allowed = await canEntityDo(sql, entityId, "plane", action);

  if (!allowed) {
    const denial: PermissionDenial = {
      entity_id: entityId,
      resource: "plane",
      action,
      reason: `Work session "${operation}" requires plane.${action}`,
      timestamp: new Date().toISOString(),
    };
    if (config.log_denials) logDenial(denial);
    if (config.enforce) return { allowed: false, denial };
  }

  return { allowed: true };
}

// Pure version for testing without SQL

export function guardAgentDispatchPure(
  entityRoles: string[],
  allRoles: Role[],
  rolePermissions: Map<string, Permission[]>,
  agentName: string,
  config: GuardConfig = DEFAULT_GUARD_CONFIG,
): GuardResult {
  if (!config.enabled) return { allowed: true };

  const required = getRequiredPermissions(agentName);

  for (const { resource, action } of required) {
    const allowed = checkPermissionPure(entityRoles, allRoles, rolePermissions, resource, action);
    if (!allowed) {
      const denial: PermissionDenial = {
        entity_id: "pure-check",
        resource,
        action,
        reason: `Agent "${agentName}" requires ${resource}.${action}`,
        timestamp: new Date().toISOString(),
      };
      if (config.log_denials) logDenial(denial);
      if (config.enforce) return { allowed: false, denial };
    }
  }

  return { allowed: true };
}

// RBAC entity resolution — map agent name to RBAC entity ID

const rbacEntityCache = new Map<string, { id: string; expiresAt: number }>();
const RBAC_ENTITY_CACHE_TTL = 60_000; // 1 minute

/**
 * Resolve an agent name (e.g. "dev", "critic") to its RBAC entity ID.
 * Looks up rbac_entities by archetype matching the agent name.
 * Returns null if no matching entity found (guard should allow by default).
 */
export async function resolveRbacEntityId(sql: any, agentName: string): Promise<string | null> {
  const cached = rbacEntityCache.get(agentName);
  if (cached && Date.now() < cached.expiresAt) return cached.id;

  const rows = await sql`
    SELECT id FROM rbac_entities WHERE archetype = ${agentName} LIMIT 1
  `;
  if (rows.length === 0) return null;

  rbacEntityCache.set(agentName, { id: rows[0].id, expiresAt: Date.now() + RBAC_ENTITY_CACHE_TTL });
  return rows[0].id;
}

/** Clear RBAC entity cache (for testing). */
export function clearRbacEntityCache(): void {
  rbacEntityCache.clear();
}

// Format denial for user display

export function formatDenialMessage(denial: PermissionDenial): string {
  return `Permission denied: ${denial.resource}.${denial.action} — ${denial.reason}`;
}
