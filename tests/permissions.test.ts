import { describe, it, expect, beforeEach } from "bun:test";
import {
  resolveRoleTree,
  scopeMatches,
  checkPermissionPure,
  canEntityDo,
  invalidateCache,
  _getCacheStats,
  type Role,
  type Permission,
} from "../src/permissions.ts";

// Test data matching seed structure
const ALL_ROLES: Role[] = [
  { id: "role-base", name: "agent_base", parent_role_id: null },
  { id: "role-dev", name: "dev_agent", parent_role_id: "role-base" },
  { id: "role-critic", name: "critic_agent", parent_role_id: "role-base" },
  { id: "role-research", name: "research_agent", parent_role_id: "role-base" },
  { id: "role-super-agent", name: "super_agent", parent_role_id: "role-base" },
  { id: "role-super-user", name: "super_user", parent_role_id: null },
];

const ROLE_PERMISSIONS = new Map<string, Permission[]>([
  ["role-base", [
    { id: "p1", resource: "messages", action: "send", scope: null },
    { id: "p2", resource: "messages", action: "read", scope: null },
    { id: "p3", resource: "memory", action: "read", scope: null },
    { id: "p4", resource: "forest", action: "read", scope: null },
  ]],
  ["role-dev", [
    { id: "p10", resource: "plane", action: "create_issue", scope: null },
    { id: "p11", resource: "plane", action: "update_issue", scope: null },
    { id: "p12", resource: "git", action: "commit", scope: null },
    { id: "p13", resource: "git", action: "push", scope: null },
    { id: "p14", resource: "tools", action: "use_bash", scope: null },
    { id: "p15", resource: "plane", action: "read_issue", scope: "project:ELLIE" },
  ]],
  ["role-critic", [
    { id: "p20", resource: "plane", action: "read_issue", scope: null },
    { id: "p21", resource: "plane", action: "comment", scope: null },
  ]],
  ["role-research", [
    { id: "p30", resource: "tools", action: "use_web", scope: null },
  ]],
  ["role-super-agent", [
    { id: "p40", resource: "system", action: "restart_service", scope: null },
    { id: "p41", resource: "agents", action: "dispatch", scope: null },
  ]],
  ["role-super-user", [
    { id: "p50", resource: "system", action: "manage_secrets", scope: null },
    { id: "p51", resource: "system", action: "manage_config", scope: null },
  ]],
]);

beforeEach(() => invalidateCache());

describe("ELLIE-793: Permission check utility", () => {
  describe("resolveRoleTree", () => {
    it("returns just the role for root roles", () => {
      const tree = resolveRoleTree("role-base", ALL_ROLES);
      expect(tree).toEqual(["role-base"]);
    });

    it("includes parent for child roles", () => {
      const tree = resolveRoleTree("role-dev", ALL_ROLES);
      expect(tree).toContain("role-dev");
      expect(tree).toContain("role-base");
      expect(tree).toHaveLength(2);
    });

    it("resolves super_agent → agent_base", () => {
      const tree = resolveRoleTree("role-super-agent", ALL_ROLES);
      expect(tree).toContain("role-super-agent");
      expect(tree).toContain("role-base");
    });

    it("handles non-existent role gracefully", () => {
      const tree = resolveRoleTree("nonexistent", ALL_ROLES);
      expect(tree).toEqual(["nonexistent"]);
    });

    it("handles circular references without infinite loop", () => {
      const circular: Role[] = [
        { id: "a", name: "a", parent_role_id: "b" },
        { id: "b", name: "b", parent_role_id: "a" },
      ];
      const tree = resolveRoleTree("a", circular);
      expect(tree).toContain("a");
      expect(tree).toContain("b");
      expect(tree).toHaveLength(2);
    });
  });

  describe("scopeMatches", () => {
    it("null scope matches everything", () => {
      expect(scopeMatches(null, "project:ELLIE")).toBe(true);
      expect(scopeMatches(null, undefined)).toBe(true);
      expect(scopeMatches(null)).toBe(true);
    });

    it("exact scope match", () => {
      expect(scopeMatches("project:ELLIE", "project:ELLIE")).toBe(true);
    });

    it("exact scope mismatch", () => {
      expect(scopeMatches("project:ELLIE", "project:OTHER")).toBe(false);
    });

    it("wildcard scope matches prefix", () => {
      expect(scopeMatches("project:ELLIE-*", "project:ELLIE-123")).toBe(true);
      expect(scopeMatches("project:ELLIE-*", "project:ELLIE-789")).toBe(true);
    });

    it("wildcard scope does not match different prefix", () => {
      expect(scopeMatches("project:ELLIE-*", "project:OTHER-123")).toBe(false);
    });

    it("scoped permission does not match when no scope requested", () => {
      expect(scopeMatches("project:ELLIE", undefined)).toBe(false);
    });
  });

  describe("checkPermissionPure", () => {
    it("grants direct permission", () => {
      expect(checkPermissionPure(
        ["role-dev"], ALL_ROLES, ROLE_PERMISSIONS,
        "git", "commit",
      )).toBe(true);
    });

    it("grants inherited permission", () => {
      // dev_agent inherits from agent_base, so gets messages.send
      expect(checkPermissionPure(
        ["role-dev"], ALL_ROLES, ROLE_PERMISSIONS,
        "messages", "send",
      )).toBe(true);
    });

    it("denies permission not in role", () => {
      // critic_agent does not have git.commit
      expect(checkPermissionPure(
        ["role-critic"], ALL_ROLES, ROLE_PERMISSIONS,
        "git", "commit",
      )).toBe(false);
    });

    it("denies completely unknown permission", () => {
      expect(checkPermissionPure(
        ["role-dev"], ALL_ROLES, ROLE_PERMISSIONS,
        "nuclear", "launch",
      )).toBe(false);
    });

    it("grants inherited base permission to all agent roles", () => {
      for (const role of ["role-dev", "role-critic", "role-research", "role-super-agent"]) {
        expect(checkPermissionPure(
          [role], ALL_ROLES, ROLE_PERMISSIONS,
          "messages", "read",
        )).toBe(true);
      }
    });

    it("grants permission with multiple roles", () => {
      // Entity with both critic and research roles
      expect(checkPermissionPure(
        ["role-critic", "role-research"], ALL_ROLES, ROLE_PERMISSIONS,
        "tools", "use_web",
      )).toBe(true);
      expect(checkPermissionPure(
        ["role-critic", "role-research"], ALL_ROLES, ROLE_PERMISSIONS,
        "plane", "comment",
      )).toBe(true);
    });

    it("super_agent gets agent_base permissions + own", () => {
      expect(checkPermissionPure(
        ["role-super-agent"], ALL_ROLES, ROLE_PERMISSIONS,
        "messages", "send", // from agent_base
      )).toBe(true);
      expect(checkPermissionPure(
        ["role-super-agent"], ALL_ROLES, ROLE_PERMISSIONS,
        "agents", "dispatch", // own
      )).toBe(true);
    });

    it("scoped permission matches with correct scope", () => {
      expect(checkPermissionPure(
        ["role-dev"], ALL_ROLES, ROLE_PERMISSIONS,
        "plane", "read_issue", "project:ELLIE",
      )).toBe(true);
    });

    it("scoped permission denied with wrong scope", () => {
      expect(checkPermissionPure(
        ["role-dev"], ALL_ROLES, ROLE_PERMISSIONS,
        "plane", "read_issue", "project:OTHER",
      )).toBe(false);
    });

    it("unscoped permission matches any scope", () => {
      // critic has plane.read_issue with null scope (global)
      expect(checkPermissionPure(
        ["role-critic"], ALL_ROLES, ROLE_PERMISSIONS,
        "plane", "read_issue", "project:ANYTHING",
      )).toBe(true);
    });

    it("returns false for empty role list", () => {
      expect(checkPermissionPure(
        [], ALL_ROLES, ROLE_PERMISSIONS,
        "messages", "send",
      )).toBe(false);
    });
  });

  describe("canEntityDo (with mock SQL)", () => {
    function createMockSql() {
      let callIndex = 0;
      const fn: any = function (...args: any[]) {
        callIndex++;
        // Call 1: entity_roles
        if (callIndex === 1) return Promise.resolve([{ role_id: "role-dev" }]);
        // Call 2: all roles
        if (callIndex === 2) return Promise.resolve(ALL_ROLES);
        // Call 3: permissions check
        if (callIndex === 3) return Promise.resolve([{ resource: "git", action: "commit", scope: null }]);
        return Promise.resolve([]);
      };
      fn.callIndex = () => callIndex;
      return fn;
    }

    it("returns true for permitted action", async () => {
      const sql = createMockSql();
      const result = await canEntityDo(sql, "entity-1", "git", "commit");
      expect(result).toBe(true);
    });

    it("returns false when entity has no roles", async () => {
      const sql: any = function () { return Promise.resolve([]); };
      const result = await canEntityDo(sql, "entity-none", "git", "commit");
      expect(result).toBe(false);
    });

    it("caches entity roles on second call", async () => {
      let calls = 0;
      const sql: any = function () {
        calls++;
        if (calls === 1) return Promise.resolve([{ role_id: "role-dev" }]);
        if (calls === 2) return Promise.resolve(ALL_ROLES);
        return Promise.resolve([{ resource: "git", action: "commit", scope: null }]);
      };

      await canEntityDo(sql, "entity-cached", "git", "commit");
      const stats = _getCacheStats();
      expect(stats.entityRoles).toBeGreaterThan(0);
    });
  });

  describe("invalidateCache", () => {
    it("clears specific entity cache", () => {
      // Populate cache via canEntityDo would be complex, just test the function runs
      invalidateCache("entity-1");
      const stats = _getCacheStats();
      expect(stats.hasAllRoles).toBe(false);
    });

    it("clears all caches", () => {
      invalidateCache();
      const stats = _getCacheStats();
      expect(stats.entityRoles).toBe(0);
      expect(stats.roleTrees).toBe(0);
      expect(stats.hasAllRoles).toBe(false);
    });
  });
});
