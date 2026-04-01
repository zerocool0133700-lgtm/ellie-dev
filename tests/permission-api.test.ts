import { describe, it, expect } from "bun:test";
import {
  validateCreateEntity,
  validateUpdateEntity,
  validateCreateRole,
  listEntities,
  getEntity,
  createEntity,
  updateEntity,
  listRoles,
  createRole,
  checkPermission,
} from "../src/permission-api.ts";

// Mock SQL helpers
function mockSql(returnValue: any = []) {
  const calls: any[] = [];
  const fn: any = function (...args: any[]) {
    calls.push({ type: "tagged", args });
    return Promise.resolve(returnValue);
  };
  fn.unsafe = function (query: string) {
    calls.push({ type: "unsafe", query });
    return Promise.resolve(returnValue);
  };
  fn.calls = calls;
  return fn;
}

const MOCK_ENTITY = {
  id: "e0000000-0000-0000-0000-000000000003",
  entity_type: "agent",
  name: "James",
  archetype: "dev",
  metadata: {},
  created_at: "2026-03-16T12:00:00Z",
  roles: [{ id: "role-1", name: "dev_agent" }],
};

describe("ELLIE-797: Permission management API", () => {
  describe("validateCreateEntity", () => {
    it("accepts valid input", () => {
      expect(validateCreateEntity({ name: "Test", entity_type: "agent" })).toEqual({ valid: true });
    });

    it("accepts all entity types", () => {
      for (const t of ["user", "super_agent", "agent"]) {
        expect(validateCreateEntity({ name: "Test", entity_type: t }).valid).toBe(true);
      }
    });

    it("rejects missing name", () => {
      expect(validateCreateEntity({ entity_type: "agent" }).valid).toBe(false);
    });

    it("rejects invalid entity_type", () => {
      expect(validateCreateEntity({ name: "Test", entity_type: "admin" }).valid).toBe(false);
    });

    it("rejects null input", () => {
      expect(validateCreateEntity(null).valid).toBe(false);
    });
  });

  describe("validateUpdateEntity", () => {
    it("accepts name update", () => {
      expect(validateUpdateEntity({ name: "New Name" }).valid).toBe(true);
    });

    it("accepts role additions", () => {
      expect(validateUpdateEntity({ add_roles: ["role-1"] }).valid).toBe(true);
    });

    it("accepts role removals", () => {
      expect(validateUpdateEntity({ remove_roles: ["role-1"] }).valid).toBe(true);
    });

    it("rejects empty update", () => {
      expect(validateUpdateEntity({}).valid).toBe(false);
    });

    it("rejects null", () => {
      expect(validateUpdateEntity(null).valid).toBe(false);
    });
  });

  describe("validateCreateRole", () => {
    it("accepts valid input", () => {
      expect(validateCreateRole({ name: "new_role" }).valid).toBe(true);
    });

    it("accepts with parent and description", () => {
      expect(validateCreateRole({ name: "child", parent_role_id: "parent-id", description: "A child role" }).valid).toBe(true);
    });

    it("rejects missing name", () => {
      expect(validateCreateRole({}).valid).toBe(false);
    });
  });

  describe("listEntities", () => {
    it("returns entities from SQL", async () => {
      const sql = mockSql([MOCK_ENTITY]);
      const result = await listEntities(sql);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("James");
    });

    it("returns empty array when no entities", async () => {
      const result = await listEntities(mockSql([]));
      expect(result).toEqual([]);
    });
  });

  describe("getEntity", () => {
    it("returns entity with resolved permissions", async () => {
      let callIdx = 0;
      const sql: any = function (...args: any[]) {
        callIdx++;
        if (callIdx === 1) return Promise.resolve([MOCK_ENTITY]); // entity query
        if (callIdx === 2) return Promise.resolve([{ id: "role-1", name: "dev_agent", parent_role_id: null }]); // all roles
        if (callIdx === 3) return Promise.resolve([{ resource: "git", action: "commit", scope: null }]); // permissions
        return Promise.resolve([]);
      };
      const result = await getEntity(sql, "e0000000-0000-0000-0000-000000000003");
      expect(result).not.toBeNull();
      expect(result!.name).toBe("James");
      expect(result!.resolved_permissions).toHaveLength(1);
      expect(result!.resolved_permissions[0].resource).toBe("git");
    });

    it("returns null for non-existent entity", async () => {
      const result = await getEntity(mockSql([]), "nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("createEntity", () => {
    it("inserts entity and returns it", async () => {
      const sql = mockSql([{ id: "new-id", entity_type: "agent", name: "New", archetype: null, metadata: {}, created_at: "2026-03-16" }]);
      const result = await createEntity(sql, { name: "New", entity_type: "agent" });
      expect(result.name).toBe("New");
      expect(sql.calls.length).toBe(1);
    });

    it("assigns roles when provided", async () => {
      const sql = mockSql([{ id: "new-id", entity_type: "agent", name: "New", archetype: null, metadata: {}, created_at: "2026-03-16" }]);
      await createEntity(sql, { name: "New", entity_type: "agent", role_ids: ["role-1", "role-2"] });
      expect(sql.calls.length).toBe(3); // 1 insert + 2 role assigns
    });
  });

  describe("updateEntity", () => {
    it("updates entity fields", async () => {
      const sql = mockSql([]);
      await updateEntity(sql, "entity-1", { name: "Updated" });
      expect(sql.calls.length).toBe(1);
      expect(sql.calls[0].type).toBe("tagged");
    });

    it("adds roles", async () => {
      const sql = mockSql([]);
      await updateEntity(sql, "entity-1", { add_roles: ["role-a"] });
      expect(sql.calls.length).toBe(1);
    });

    it("removes roles", async () => {
      const sql = mockSql([]);
      await updateEntity(sql, "entity-1", { remove_roles: ["role-b"] });
      expect(sql.calls.length).toBe(1);
    });
  });

  describe("listRoles", () => {
    it("returns roles from SQL", async () => {
      const roles = [{ id: "r1", name: "agent_base", parent_role_id: null }];
      const result = await listRoles(mockSql(roles));
      expect(result).toHaveLength(1);
    });
  });

  describe("createRole", () => {
    it("inserts role and returns it", async () => {
      const sql = mockSql([{ id: "new-role", name: "test_role", parent_role_id: null }]);
      const result = await createRole(sql, { name: "test_role" });
      expect(result.name).toBe("test_role");
    });
  });

  describe("checkPermission", () => {
    it("returns allowed status", async () => {
      let callIdx = 0;
      const sql: any = function () {
        callIdx++;
        if (callIdx === 1) return Promise.resolve([{ role_id: "role-1" }]);
        if (callIdx === 2) return Promise.resolve([{ id: "role-1", name: "dev", parent_role_id: null }]);
        return Promise.resolve([{ resource: "git", action: "commit", scope: null }]);
      };
      const result = await checkPermission(sql, "entity-1", "git", "commit");
      expect(result.allowed).toBe(true);
      expect(result.entity_id).toBe("entity-1");
      expect(result.resource).toBe("git");
      expect(result.action).toBe("commit");
    });
  });
});
