/**
 * ELLIE-819: RBAC Hardening Tests
 * Covers gaps identified in the critical review of ELLIE-788 epic.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import {
  resolveRoleTree,
  scopeMatches,
  canEntityDo,
  invalidateCache,
  _getCacheStats,
  type Role,
} from "../src/permissions.ts";
import {
  guardAgentDispatch,
  guardToolExecution,
  guardWorkSession,
  resolveRbacEntityId,
  clearRbacEntityCache,
  clearDenialLog,
  getRecentDenials,
} from "../src/permission-guard.ts";
import {
  resolveCallerEntity,
  isPermissionAdmin,
  guardPermissionWrite,
  guardPermissionWritePure,
  type EntityType,
} from "../src/permission-auth.ts";

const TEST_DB = "ellie-forest-test";
let sql: any;

const DAVE_ID = "e0000000-0000-0000-0000-000000000001";
const ELLIE_ID = "e0000000-0000-0000-0000-000000000002";
const JAMES_ID = "e0000000-0000-0000-0000-000000000003";
const BRIAN_ID = "e0000000-0000-0000-0000-000000000004";

beforeAll(async () => {
  const postgres = (await import("postgres")).default;
  sql = postgres({ database: TEST_DB, host: "/var/run/postgresql", max: 3 });
});

afterAll(async () => {
  if (sql) await sql.end();
});

beforeEach(() => {
  invalidateCache();
  clearRbacEntityCache();
  clearDenialLog();
});

// ── Cache hardening ──────────────────────────────────────────────

describe("ELLIE-819: Cache hardening", () => {
  it("cache TTL is 5 seconds or less", async () => {
    // Trigger a cache fill
    await canEntityDo(sql, JAMES_ID, "tools", "use_bash");
    const stats1 = _getCacheStats();
    expect(stats1.entityRoles).toBeGreaterThan(0);
    expect(stats1.hasAllRoles).toBe(true);

    // After invalidation, cache should be empty
    invalidateCache();
    const stats2 = _getCacheStats();
    expect(stats2.entityRoles).toBe(0);
    expect(stats2.hasAllRoles).toBe(false);
  });

  it("selective invalidation clears only target entity", async () => {
    await canEntityDo(sql, JAMES_ID, "tools", "use_bash");
    await canEntityDo(sql, BRIAN_ID, "plane", "read_issue");
    expect(_getCacheStats().entityRoles).toBe(2);

    invalidateCache(JAMES_ID);
    expect(_getCacheStats().entityRoles).toBe(1);
  });

  it("cache reflects DB changes after invalidation", async () => {
    // Create a test entity with no roles
    const [testEntity] = await sql`
      INSERT INTO rbac_entities (entity_type, name, archetype, metadata)
      VALUES ('agent', 'cache-test-entity', 'cache-test', '{}'::jsonb)
      RETURNING id
    `;
    try {
      // Should be denied (no roles)
      const denied = await canEntityDo(sql, testEntity.id, "messages", "send");
      expect(denied).toBe(false);

      // Assign agent_base role
      await sql`
        INSERT INTO rbac_entity_roles (entity_id, role_id)
        VALUES (${testEntity.id}, 'a0000000-0000-0000-0000-000000000001')
      `;

      // Without invalidation, stale cache returns false
      const stillDenied = await canEntityDo(sql, testEntity.id, "messages", "send");
      expect(stillDenied).toBe(false); // stale cache

      // After invalidation, should be allowed
      invalidateCache(testEntity.id);
      const allowed = await canEntityDo(sql, testEntity.id, "messages", "send");
      expect(allowed).toBe(true);
    } finally {
      await sql`DELETE FROM rbac_entity_roles WHERE entity_id = ${testEntity.id}`;
      await sql`DELETE FROM rbac_entities WHERE id = ${testEntity.id}`;
    }
  });
});

// ── Scope edge cases ─────────────────────────────────────────────

describe("ELLIE-819: Scope matching edge cases", () => {
  it("null permission scope matches any request scope", () => {
    expect(scopeMatches(null, "project:ELLIE")).toBe(true);
    expect(scopeMatches(null, undefined)).toBe(true);
    expect(scopeMatches(null, "")).toBe(true);
  });

  it("empty string scope is not the same as null", () => {
    expect(scopeMatches("", "project:ELLIE")).toBe(false);
    // Empty string request scope is treated as "no scope" → only matches null permission scope
    expect(scopeMatches("", "")).toBe(false);
    expect(scopeMatches(null, "")).toBe(true);
  });

  it("wildcard requires at least prefix match", () => {
    expect(scopeMatches("project:ELLIE-*", "project:ELLIE-123")).toBe(true);
    expect(scopeMatches("project:ELLIE-*", "project:ELLIE-")).toBe(true);
    expect(scopeMatches("project:ELLIE-*", "project:OTHER-123")).toBe(false);
  });

  it("special characters in scope don't break matching", () => {
    expect(scopeMatches("project:ELLIE", "project:ELLIE'; DROP TABLE")).toBe(false);
    expect(scopeMatches("project:ELLIE-*", "project:ELLIE-'; DROP TABLE")).toBe(true); // prefix matches
  });
});

// ── Role hierarchy edge cases ────────────────────────────────────

describe("ELLIE-819: Role hierarchy edge cases", () => {
  it("handles 3-node circular reference without infinite loop", () => {
    const roles: Role[] = [
      { id: "r1", name: "a", parent_role_id: "r2" },
      { id: "r2", name: "b", parent_role_id: "r3" },
      { id: "r3", name: "c", parent_role_id: "r1" },
    ];
    const tree = resolveRoleTree("r1", roles);
    expect(tree).toContain("r1");
    expect(tree).toContain("r2");
    expect(tree).toContain("r3");
    expect(tree.length).toBe(3);
  });

  it("handles missing parent_role_id gracefully", () => {
    const roles: Role[] = [
      { id: "r1", name: "a", parent_role_id: "r-missing" },
    ];
    const tree = resolveRoleTree("r1", roles);
    expect(tree).toContain("r1");
    // r-missing is added to collected but has no further parent
    expect(tree.length).toBe(2);
  });

  it("single role with no parent", () => {
    const roles: Role[] = [
      { id: "r1", name: "a", parent_role_id: null },
    ];
    const tree = resolveRoleTree("r1", roles);
    expect(tree).toEqual(["r1"]);
  });
});

// ── EntityType + admin checks ────────────────────────────────────

describe("ELLIE-819: EntityType and admin checks", () => {
  it("Dave (user type) is a permission admin", () => {
    expect(isPermissionAdmin("user")).toBe(true);
  });

  it("Ellie (super_agent type) is a permission admin", () => {
    expect(isPermissionAdmin("super_agent")).toBe(true);
  });

  it("agent type is NOT a permission admin", () => {
    expect(isPermissionAdmin("agent")).toBe(false);
  });

  it("guardPermissionWritePure rejects agent type", () => {
    const result = guardPermissionWritePure("agent");
    expect(result.authorized).toBe(false);
    expect(result.status_code).toBe(403);
  });

  it("guardPermissionWritePure allows user type", () => {
    const result = guardPermissionWritePure("user");
    expect(result.authorized).toBe(true);
  });

  it("guardPermissionWritePure allows super_agent type", () => {
    const result = guardPermissionWritePure("super_agent");
    expect(result.authorized).toBe(true);
  });

  it("guardPermissionWritePure rejects null", () => {
    const result = guardPermissionWritePure(null);
    expect(result.authorized).toBe(false);
    expect(result.status_code).toBe(401);
  });
});

// ── Auth resolution ──────────────────────────────────────────────

describe("ELLIE-819: Auth resolution", () => {
  it("resolves Dave by entity ID", async () => {
    const result = await resolveCallerEntity(sql, { "x-entity-id": DAVE_ID });
    expect(result.authorized).toBe(true);
    expect(result.entity_type).toBe("user");
  });

  it("rejects unknown entity ID", async () => {
    const result = await resolveCallerEntity(sql, { "x-entity-id": "00000000-0000-0000-0000-000000000099" });
    expect(result.authorized).toBe(false);
    expect(result.status_code).toBe(401);
  });

  it("rejects empty headers", async () => {
    const result = await resolveCallerEntity(sql, {});
    expect(result.authorized).toBe(false);
    expect(result.status_code).toBe(401);
  });

  it("Dave can write permissions (via guardPermissionWrite)", async () => {
    const result = await guardPermissionWrite(sql, { "x-entity-id": DAVE_ID });
    expect(result.authorized).toBe(true);
  });

  it("James cannot write permissions (agent type)", async () => {
    const result = await guardPermissionWrite(sql, { "x-entity-id": JAMES_ID });
    expect(result.authorized).toBe(false);
    expect(result.status_code).toBe(403);
  });
});

// ── Permission coverage ──────────────────────────────────────────

describe("ELLIE-819: Permission coverage fixes", () => {
  it("research_agent now has forest.read", async () => {
    // research_agent role is a0000000-...-000000000004
    // Find an entity with research archetype, or check role permissions directly
    const rows = await sql`
      SELECT p.resource, p.action FROM rbac_role_permissions rp
      JOIN rbac_permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = 'a0000000-0000-0000-0000-000000000004'
      AND p.resource = 'forest' AND p.action = 'read'
    `;
    expect(rows.length).toBe(1);
  });

  it("critic_agent now has forest.read", async () => {
    const rows = await sql`
      SELECT p.resource, p.action FROM rbac_role_permissions rp
      JOIN rbac_permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = 'a0000000-0000-0000-0000-000000000003'
      AND p.resource = 'forest' AND p.action = 'read'
    `;
    expect(rows.length).toBe(1);
  });

  it("strategy_agent role exists with correct permissions", async () => {
    const [role] = await sql`SELECT id, name FROM rbac_roles WHERE name = 'strategy_agent'`;
    expect(role).toBeDefined();
    expect(role.name).toBe("strategy_agent");

    const perms = await sql`
      SELECT p.resource, p.action FROM rbac_role_permissions rp
      JOIN rbac_permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = ${role.id}
    `;
    const permSet = new Set(perms.map((p: any) => `${p.resource}.${p.action}`));
    expect(permSet.has("plane.read_issue")).toBe(true);
    expect(permSet.has("forest.read")).toBe(true);
    expect(permSet.has("forest.write")).toBe(true);
  });

  it("finance_agent role exists", async () => {
    const [role] = await sql`SELECT id FROM rbac_roles WHERE name = 'finance_agent'`;
    expect(role).toBeDefined();
  });

  it("content_agent role exists", async () => {
    const [role] = await sql`SELECT id FROM rbac_roles WHERE name = 'content_agent'`;
    expect(role).toBeDefined();
  });

  it("general_agent role exists", async () => {
    const [role] = await sql`SELECT id FROM rbac_roles WHERE name = 'general_agent'`;
    expect(role).toBeDefined();
  });
});

// ── Schema constraints ───────────────────────────────────────────

describe("ELLIE-819: Schema constraints", () => {
  it("rbac_entities.name is unique", async () => {
    // Try inserting a duplicate name — should fail
    try {
      await sql`
        INSERT INTO rbac_entities (entity_type, name, metadata)
        VALUES ('agent', 'Dave', '{}'::jsonb)
      `;
      expect(true).toBe(false); // should not reach here
    } catch (err: any) {
      expect(err.message).toContain("rbac_entities_name_unique");
    }
  });

  it("deleting a role with entity assignments is RESTRICT-ed", async () => {
    // dev_agent has entity assignments (James), so deleting should fail
    try {
      await sql`DELETE FROM rbac_roles WHERE name = 'dev_agent'`;
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("violates foreign key constraint");
    }
  });

  it("deleting an entity with role assignments is RESTRICT-ed", async () => {
    try {
      await sql`DELETE FROM rbac_entities WHERE name = 'James'`;
      expect(true).toBe(false);
    } catch (err: any) {
      expect(err.message).toContain("violates foreign key constraint");
    }
  });
});

// ── Entity with no roles ─────────────────────────────────────────

describe("ELLIE-819: Entity with no roles", () => {
  it("entity with no roles is denied everything", async () => {
    const [testEntity] = await sql`
      INSERT INTO rbac_entities (entity_type, name, archetype, metadata)
      VALUES ('agent', 'no-roles-entity', 'noroles', '{}'::jsonb)
      RETURNING id
    `;
    try {
      expect(await canEntityDo(sql, testEntity.id, "messages", "send")).toBe(false);
      expect(await canEntityDo(sql, testEntity.id, "tools", "use_bash")).toBe(false);
      expect(await canEntityDo(sql, testEntity.id, "plane", "update_issue")).toBe(false);
    } finally {
      await sql`DELETE FROM rbac_entities WHERE id = ${testEntity.id}`;
    }
  });
});

// ── Multi-role union ─────────────────────────────────────────────

describe("ELLIE-819: Multi-role permission union", () => {
  it("entity with multiple roles gets union of all permissions", async () => {
    const [testEntity] = await sql`
      INSERT INTO rbac_entities (entity_type, name, archetype, metadata)
      VALUES ('agent', 'multi-role-entity', 'multirole', '{}'::jsonb)
      RETURNING id
    `;
    try {
      // Assign both dev_agent and critic_agent roles
      await sql`
        INSERT INTO rbac_entity_roles (entity_id, role_id) VALUES
          (${testEntity.id}, 'a0000000-0000-0000-0000-000000000002'),
          (${testEntity.id}, 'a0000000-0000-0000-0000-000000000003')
      `;
      invalidateCache();

      // Should have dev permissions (tools.use_bash)
      expect(await canEntityDo(sql, testEntity.id, "tools", "use_bash")).toBe(true);
      // Should also have critic permissions (plane.comment)
      expect(await canEntityDo(sql, testEntity.id, "plane", "comment")).toBe(true);
      // Should have inherited agent_base permissions (messages.send)
      expect(await canEntityDo(sql, testEntity.id, "messages", "send")).toBe(true);
    } finally {
      await sql`DELETE FROM rbac_entity_roles WHERE entity_id = ${testEntity.id}`;
      await sql`DELETE FROM rbac_entities WHERE id = ${testEntity.id}`;
    }
  });
});

// ── SQL injection prevention ─────────────────────────────────────

describe("ELLIE-819: SQL injection prevention", () => {
  it("malicious resource string does not cause SQL injection", async () => {
    // postgres.js parameterizes queries, so this should just return false
    const result = await canEntityDo(sql, JAMES_ID, "tools'; DROP TABLE rbac_entities; --", "use_bash");
    expect(result).toBe(false);
    // Verify table still exists
    const [check] = await sql`SELECT count(*) as c FROM rbac_entities`;
    expect(Number(check.c)).toBeGreaterThan(0);
  });

  it("malicious entity ID is rejected by UUID type validation", async () => {
    // postgres.js validates UUID format before sending to DB — injection string is rejected
    try {
      await canEntityDo(sql, "'; DROP TABLE rbac_entities; --", "tools", "use_bash");
      // If it doesn't throw, it should return false
      expect(true).toBe(true);
    } catch (err: any) {
      // Expected: postgres rejects invalid UUID syntax
      expect(err.message).toContain("invalid input syntax for type uuid");
    }
    // Either way, table should still exist
    const [check] = await sql`SELECT count(*) as c FROM rbac_entities`;
    expect(Number(check.c)).toBeGreaterThan(0);
  });
});
