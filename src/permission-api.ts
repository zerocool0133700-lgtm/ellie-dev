/**
 * Permission Management API — ELLIE-797
 * REST operations for managing entities, roles, and permissions.
 * Pure functions with injected SQL for testability.
 */

import { canEntityDo, resolveRoleTree, invalidateCache, type Role, type Permission } from "./permissions.ts";

// Types

export interface EntityWithRoles {
  id: string;
  entity_type: string;
  name: string;
  archetype: string | null;
  metadata: Record<string, any>;
  roles: { id: string; name: string }[];
  created_at: string;
}

export interface EntityDetail extends EntityWithRoles {
  resolved_permissions: { resource: string; action: string; scope: string | null }[];
}

export interface CreateEntityInput {
  name: string;
  entity_type: "user" | "super_agent" | "agent";
  archetype?: string;
  metadata?: Record<string, any>;
  role_ids?: string[];
}

export interface UpdateEntityInput {
  name?: string;
  archetype?: string;
  metadata?: Record<string, any>;
  add_roles?: string[];
  remove_roles?: string[];
}

export interface CreateRoleInput {
  name: string;
  description?: string;
  parent_role_id?: string;
}

// Validation

export function validateCreateEntity(input: any): { valid: boolean; error?: string } {
  if (!input || typeof input !== "object") return { valid: false, error: "Request body required" };
  if (!input.name || typeof input.name !== "string") return { valid: false, error: "name is required" };
  if (!["user", "super_agent", "agent"].includes(input.entity_type)) {
    return { valid: false, error: "entity_type must be user, super_agent, or agent" };
  }
  return { valid: true };
}

export function validateUpdateEntity(input: any): { valid: boolean; error?: string } {
  if (!input || typeof input !== "object") return { valid: false, error: "Request body required" };
  const hasField = input.name || input.archetype !== undefined || input.metadata || input.add_roles || input.remove_roles;
  if (!hasField) return { valid: false, error: "At least one field to update is required" };
  return { valid: true };
}

export function validateCreateRole(input: any): { valid: boolean; error?: string } {
  if (!input || typeof input !== "object") return { valid: false, error: "Request body required" };
  if (!input.name || typeof input.name !== "string") return { valid: false, error: "name is required" };
  return { valid: true };
}

// DB operations

export async function listEntities(sql: any): Promise<EntityWithRoles[]> {
  const entities = await sql`
    SELECT e.id, e.entity_type, e.name, e.archetype, e.metadata, e.created_at,
           COALESCE(json_agg(json_build_object('id', r.id, 'name', r.name)) FILTER (WHERE r.id IS NOT NULL), '[]') as roles
    FROM rbac_entities e
    LEFT JOIN rbac_entity_roles er ON er.entity_id = e.id
    LEFT JOIN rbac_roles r ON r.id = er.role_id
    GROUP BY e.id
    ORDER BY e.name
  `;
  return entities;
}

export async function getEntity(sql: any, entityId: string): Promise<EntityDetail | null> {
  const entities = await sql`
    SELECT e.id, e.entity_type, e.name, e.archetype, e.metadata, e.created_at,
           COALESCE(json_agg(json_build_object('id', r.id, 'name', r.name)) FILTER (WHERE r.id IS NOT NULL), '[]') as roles
    FROM rbac_entities e
    LEFT JOIN rbac_entity_roles er ON er.entity_id = e.id
    LEFT JOIN rbac_roles r ON r.id = er.role_id
    WHERE e.id = ${entityId}
    GROUP BY e.id
  `;
  if (entities.length === 0) return null;

  const entity = entities[0];

  // Resolve all permissions
  const roleIds = entity.roles.map((r: any) => r.id).filter(Boolean);
  let resolvedPermissions: any[] = [];
  if (roleIds.length > 0) {
    const allRoles = await sql`SELECT id, name, parent_role_id FROM rbac_roles`;
    const allRoleIds = new Set<string>();
    for (const roleId of roleIds) {
      for (const id of resolveRoleTree(roleId, allRoles)) allRoleIds.add(id);
    }
    const roleIdArray = [...allRoleIds];
    resolvedPermissions = await sql`
      SELECT DISTINCT p.resource, p.action, p.scope
      FROM rbac_role_permissions rp
      JOIN rbac_permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = ANY(${roleIdArray})
      ORDER BY p.resource, p.action
    `;
  }

  return { ...entity, resolved_permissions: resolvedPermissions };
}

export async function createEntity(sql: any, input: CreateEntityInput): Promise<EntityWithRoles> {
  const rows = await sql`
    INSERT INTO rbac_entities (entity_type, name, archetype, metadata)
    VALUES (${input.entity_type}, ${input.name}, ${input.archetype ?? null}, ${JSON.stringify(input.metadata ?? {})})
    RETURNING *
  `;
  const entity = rows[0];

  if (input.role_ids?.length) {
    for (const roleId of input.role_ids) {
      await sql`INSERT INTO rbac_entity_roles (entity_id, role_id) VALUES (${entity.id}, ${roleId}) ON CONFLICT DO NOTHING`;
    }
  }

  invalidateCache(entity.id);
  return { ...entity, roles: [] };
}

export async function updateEntity(sql: any, entityId: string, input: UpdateEntityInput): Promise<boolean> {
  if (input.name || input.archetype !== undefined || input.metadata) {
    const sets: string[] = [];
    if (input.name) sets.push(`name = '${input.name.replace(/'/g, "''")}'`);
    if (input.archetype !== undefined) sets.push(input.archetype ? `archetype = '${input.archetype}'` : "archetype = NULL");
    if (input.metadata) sets.push(`metadata = '${JSON.stringify(input.metadata)}'::jsonb`);
    if (sets.length > 0) {
      await sql.unsafe(`UPDATE rbac_entities SET ${sets.join(", ")} WHERE id = '${entityId}'`);
    }
  }

  if (input.add_roles?.length) {
    for (const roleId of input.add_roles) {
      await sql`INSERT INTO rbac_entity_roles (entity_id, role_id) VALUES (${entityId}, ${roleId}) ON CONFLICT DO NOTHING`;
    }
  }

  if (input.remove_roles?.length) {
    for (const roleId of input.remove_roles) {
      await sql`DELETE FROM rbac_entity_roles WHERE entity_id = ${entityId} AND role_id = ${roleId}`;
    }
  }

  invalidateCache(entityId);
  return true;
}

export async function listRoles(sql: any): Promise<Role[]> {
  return sql`SELECT id, name, parent_role_id, description, created_at FROM rbac_roles ORDER BY name`;
}

export async function createRole(sql: any, input: CreateRoleInput): Promise<Role> {
  const rows = await sql`
    INSERT INTO rbac_roles (name, description, parent_role_id)
    VALUES (${input.name}, ${input.description ?? null}, ${input.parent_role_id ?? null})
    RETURNING *
  `;
  invalidateCache();
  return rows[0];
}

export async function checkPermission(
  sql: any,
  entityId: string,
  resource: string,
  action: string,
  scope?: string,
): Promise<{ allowed: boolean; entity_id: string; resource: string; action: string; scope?: string }> {
  const allowed = await canEntityDo(sql, entityId, resource, action, scope);
  return { allowed, entity_id: entityId, resource, action, scope };
}
