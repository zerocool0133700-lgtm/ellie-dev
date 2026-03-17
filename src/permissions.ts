/**
 * Permission Check Utility — ELLIE-793
 * Resolves role inheritance and checks entity permissions.
 * Pure functions with injected SQL for testability + in-memory caching.
 */

// Types

export interface Role {
  id: string;
  name: string;
  parent_role_id: string | null;
}

export interface Permission {
  id: string;
  resource: string;
  action: string;
  scope: string | null;
}

export interface EntityRole {
  entity_id: string;
  role_id: string;
}

// Cache

interface CacheEntry<T> {
  value: T;
  expires_at: number;
}

const roleTreeCache = new Map<string, CacheEntry<string[]>>();
const entityRolesCache = new Map<string, CacheEntry<string[]>>();
const allRolesCache: { value: Role[] | null; expires_at: number } = { value: null, expires_at: 0 };

const MAX_CACHE_ENTRIES = 500; // LRU eviction cap — prevents unbounded growth from random UUID probing

function evictIfNeeded(cache: Map<string, CacheEntry<any>>): void {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  // Evict oldest entries (Map preserves insertion order)
  const excess = cache.size - MAX_CACHE_ENTRIES;
  let removed = 0;
  for (const key of cache.keys()) {
    if (removed >= excess) break;
    cache.delete(key);
    removed++;
  }
}

const CACHE_TTL_MS = 5_000; // 5 seconds — short TTL to minimize stale-permission window after revocation

function isFresh<T>(entry: CacheEntry<T> | { value: T | null; expires_at: number }): boolean {
  return entry.value !== null && Date.now() < entry.expires_at;
}

// Role hierarchy resolution

export function resolveRoleTree(roleId: string, allRoles: Role[]): string[] {
  const roleMap = new Map(allRoles.map(r => [r.id, r]));
  const collected = new Set<string>();
  const queue = [roleId];

  while (queue.length > 0) {
    const current = queue.pop()!;
    if (collected.has(current)) continue;
    collected.add(current);

    const role = roleMap.get(current);
    if (role?.parent_role_id && !collected.has(role.parent_role_id)) {
      queue.push(role.parent_role_id);
    }
  }

  return [...collected];
}

// Scope matching

export function scopeMatches(permScope: string | null, requestScope?: string): boolean {
  // No scope on permission = global (matches everything)
  if (permScope === null || permScope === undefined) return true;
  // No scope requested = match only unscoped permissions
  if (!requestScope) return permScope === null;
  // Exact match
  if (permScope === requestScope) return true;
  // Wildcard match: "project:ELLIE-*" matches "project:ELLIE-123"
  if (permScope.endsWith("*")) {
    const prefix = permScope.slice(0, -1);
    return requestScope.startsWith(prefix);
  }
  return false;
}

// Pure permission check (no DB, for testing)

export function checkPermissionPure(
  entityRoles: string[],
  allRoles: Role[],
  rolePermissions: Map<string, Permission[]>,
  resource: string,
  action: string,
  scope?: string,
): boolean {
  // Collect all role IDs including inherited
  const allRoleIds = new Set<string>();
  for (const roleId of entityRoles) {
    for (const id of resolveRoleTree(roleId, allRoles)) {
      allRoleIds.add(id);
    }
  }

  // Check permissions for all collected roles
  for (const roleId of allRoleIds) {
    const perms = rolePermissions.get(roleId) ?? [];
    for (const perm of perms) {
      if (perm.resource === resource && perm.action === action && scopeMatches(perm.scope, scope)) {
        return true;
      }
    }
  }

  return false;
}

// DB-backed permission check with caching

export async function canEntityDo(
  sql: any,
  entityId: string,
  resource: string,
  action: string,
  scope?: string,
): Promise<boolean> {
  // 1. Get entity's direct roles (cached)
  let directRoleIds: string[];
  const cachedEntityRoles = entityRolesCache.get(entityId);
  if (cachedEntityRoles && isFresh(cachedEntityRoles)) {
    directRoleIds = cachedEntityRoles.value;
  } else {
    const rows = await sql`
      SELECT role_id FROM rbac_entity_roles WHERE entity_id = ${entityId}
    `;
    directRoleIds = rows.map((r: any) => r.role_id);
    entityRolesCache.set(entityId, { value: directRoleIds, expires_at: Date.now() + CACHE_TTL_MS });
    evictIfNeeded(entityRolesCache);
  }

  if (directRoleIds.length === 0) return false;

  // 2. Get all roles (cached)
  let allRoles: Role[];
  if (isFresh(allRolesCache)) {
    allRoles = allRolesCache.value!;
  } else {
    allRoles = await sql`SELECT id, name, parent_role_id FROM rbac_roles`;
    allRolesCache.value = allRoles;
    allRolesCache.expires_at = Date.now() + CACHE_TTL_MS;
  }

  // 3. Resolve full role tree
  const allRoleIds = new Set<string>();
  for (const roleId of directRoleIds) {
    const cacheKey = roleId;
    const cachedTree = roleTreeCache.get(cacheKey);
    if (cachedTree && isFresh(cachedTree)) {
      for (const id of cachedTree.value) allRoleIds.add(id);
    } else {
      const tree = resolveRoleTree(roleId, allRoles);
      roleTreeCache.set(cacheKey, { value: tree, expires_at: Date.now() + CACHE_TTL_MS });
      evictIfNeeded(roleTreeCache);
      for (const id of tree) allRoleIds.add(id);
    }
  }

  // 4. Check permissions for collected roles
  const roleIdArray = [...allRoleIds];
  const permissions = await sql`
    SELECT p.resource, p.action, p.scope
    FROM rbac_role_permissions rp
    JOIN rbac_permissions p ON p.id = rp.permission_id
    WHERE rp.role_id = ANY(${roleIdArray})
    AND p.resource = ${resource}
    AND p.action = ${action}
  `;

  for (const perm of permissions) {
    if (scopeMatches(perm.scope, scope)) return true;
  }

  return false;
}

// Cache invalidation

export function invalidateCache(entityId?: string): void {
  if (entityId) {
    entityRolesCache.delete(entityId);
  } else {
    entityRolesCache.clear();
  }
  roleTreeCache.clear();
  allRolesCache.value = null;
  allRolesCache.expires_at = 0;
}

// For testing
export function _getCacheStats(): { entityRoles: number; roleTrees: number; hasAllRoles: boolean } {
  return {
    entityRoles: entityRolesCache.size,
    roleTrees: roleTreeCache.size,
    hasAllRoles: isFresh(allRolesCache),
  };
}
