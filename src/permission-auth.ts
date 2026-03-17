/**
 * Permission API Authentication — ELLIE-802
 * Guards permission management endpoints so only super_user and super_agent can write.
 * Pure functions with injected SQL for testability.
 */

// Types

export type EntityType = "user" | "super_user" | "super_agent" | "agent";

export interface AuthResult {
  authorized: boolean;
  entity_id?: string;
  entity_type?: EntityType;
  error?: string;
  status_code: number;
}

// ELLIE-819: "user" is Dave (super_user role checked via RBAC, not entity_type)
// "super_agent" is Ellie — both can manage permissions
const ADMIN_TYPES: EntityType[] = ["user", "super_user", "super_agent"];

// Resolve entity from bridge key or entity ID header

export async function resolveCallerEntity(
  sql: any,
  headers: Record<string, string | undefined>,
): Promise<AuthResult> {
  // Check x-entity-id header (direct entity identification)
  const entityId = headers["x-entity-id"];
  if (entityId) {
    const rows = await sql`
      SELECT id, entity_type, name FROM rbac_entities WHERE id = ${entityId}
    `;
    if (rows.length === 0) {
      return { authorized: false, error: "Entity not found", status_code: 401 };
    }
    return {
      authorized: true,
      entity_id: rows[0].id,
      entity_type: rows[0].entity_type,
      status_code: 200,
    };
  }

  // Check x-bridge-key header (resolve entity from bridge key metadata)
  const bridgeKey = headers["x-bridge-key"];
  if (bridgeKey) {
    const rows = await sql`
      SELECT id, entity_type, name FROM rbac_entities
      WHERE metadata->>'bridge_key' = ${bridgeKey}
    `;
    if (rows.length === 0) {
      return { authorized: false, error: "Invalid bridge key", status_code: 401 };
    }
    return {
      authorized: true,
      entity_id: rows[0].id,
      entity_type: rows[0].entity_type,
      status_code: 200,
    };
  }

  return { authorized: false, error: "No authentication provided", status_code: 401 };
}

// Check if entity type is allowed to manage permissions

export function isPermissionAdmin(entityType: EntityType): boolean {
  return ADMIN_TYPES.includes(entityType);
}

// Full auth guard for write endpoints

export async function guardPermissionWrite(
  sql: any,
  headers: Record<string, string | undefined>,
): Promise<AuthResult> {
  const caller = await resolveCallerEntity(sql, headers);

  if (!caller.authorized) {
    return caller;
  }

  if (!isPermissionAdmin(caller.entity_type!)) {
    return {
      authorized: false,
      entity_id: caller.entity_id,
      entity_type: caller.entity_type,
      error: `Entity type "${caller.entity_type}" is not authorized to manage permissions. Requires super_user or super_agent.`,
      status_code: 403,
    };
  }

  return caller;
}

// Pure version for testing

export function guardPermissionWritePure(
  entityType: EntityType | null,
): AuthResult {
  if (!entityType) {
    return { authorized: false, error: "No authentication", status_code: 401 };
  }
  if (!isPermissionAdmin(entityType)) {
    return {
      authorized: false,
      entity_type: entityType,
      error: `Entity type "${entityType}" is not authorized`,
      status_code: 403,
    };
  }
  return { authorized: true, entity_type: entityType, status_code: 200 };
}
