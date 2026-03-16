import { describe, it, expect, beforeEach } from "bun:test";
import {
  getRequiredPermissions,
  getToolPermission,
  guardAgentDispatchPure,
  guardToolExecution,
  guardWorkSession,
  getRecentDenials,
  clearDenialLog,
  formatDenialMessage,
  type GuardConfig,
  type PermissionDenial,
} from "../src/permission-guard.ts";
import { invalidateCache, type Role, type Permission } from "../src/permissions.ts";

// Reuse test data from permissions.test.ts
const ALL_ROLES: Role[] = [
  { id: "role-base", name: "agent_base", parent_role_id: null },
  { id: "role-dev", name: "dev_agent", parent_role_id: "role-base" },
  { id: "role-critic", name: "critic_agent", parent_role_id: "role-base" },
  { id: "role-research", name: "research_agent", parent_role_id: "role-base" },
  { id: "role-super-agent", name: "super_agent", parent_role_id: "role-base" },
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
    { id: "p15", resource: "tools", action: "use_edit", scope: null },
    { id: "p16", resource: "tools", action: "use_mcp", scope: null },
  ]],
  ["role-critic", [
    { id: "p20", resource: "plane", action: "read_issue", scope: null },
    { id: "p21", resource: "plane", action: "comment", scope: null },
    { id: "p22", resource: "tools", action: "use_web", scope: null },
  ]],
  ["role-research", [
    { id: "p30", resource: "tools", action: "use_web", scope: null },
    { id: "p31", resource: "tools", action: "use_mcp", scope: null },
    { id: "p32", resource: "plane", action: "read_issue", scope: null },
  ]],
]);

beforeEach(() => { clearDenialLog(); invalidateCache(); });

describe("ELLIE-794: Permission guard", () => {
  describe("getRequiredPermissions", () => {
    it("returns dev agent permissions", () => {
      const perms = getRequiredPermissions("dev");
      expect(perms.length).toBeGreaterThan(0);
      expect(perms.some(p => p.resource === "tools" && p.action === "use_bash")).toBe(true);
      expect(perms.some(p => p.resource === "git" && p.action === "commit")).toBe(true);
    });

    it("returns critic agent permissions", () => {
      const perms = getRequiredPermissions("critic");
      expect(perms.some(p => p.resource === "plane" && p.action === "read_issue")).toBe(true);
    });

    it("returns research agent permissions", () => {
      const perms = getRequiredPermissions("research");
      expect(perms.some(p => p.resource === "tools" && p.action === "use_web")).toBe(true);
    });

    it("falls back to general for unknown agents", () => {
      const perms = getRequiredPermissions("unknown_agent");
      expect(perms.some(p => p.resource === "messages" && p.action === "send")).toBe(true);
    });
  });

  describe("getToolPermission", () => {
    it("maps bash to tools.use_bash", () => {
      expect(getToolPermission("bash")).toEqual({ resource: "tools", action: "use_bash" });
    });

    it("maps edit to tools.use_edit", () => {
      expect(getToolPermission("edit")).toEqual({ resource: "tools", action: "use_edit" });
    });

    it("maps web_search to tools.use_web", () => {
      expect(getToolPermission("web_search")).toEqual({ resource: "tools", action: "use_web" });
    });

    it("maps mcp__ prefixed tools to tools.use_mcp", () => {
      expect(getToolPermission("mcp__plane__list_issues")).toEqual({ resource: "tools", action: "use_mcp" });
      expect(getToolPermission("mcp__github__create_pr")).toEqual({ resource: "tools", action: "use_mcp" });
    });

    it("returns null for unknown tools", () => {
      expect(getToolPermission("some_unknown_tool")).toBeNull();
    });
  });

  describe("guardAgentDispatchPure", () => {
    it("allows dev agent dispatch for dev role", () => {
      const result = guardAgentDispatchPure(["role-dev"], ALL_ROLES, ROLE_PERMISSIONS, "dev");
      expect(result.allowed).toBe(true);
      expect(result.denial).toBeUndefined();
    });

    it("denies dev agent dispatch for critic role", () => {
      const result = guardAgentDispatchPure(["role-critic"], ALL_ROLES, ROLE_PERMISSIONS, "dev");
      expect(result.allowed).toBe(false);
      expect(result.denial).toBeTruthy();
      expect(result.denial!.resource).toBeTruthy();
    });

    it("allows critic dispatch for critic role", () => {
      const result = guardAgentDispatchPure(["role-critic"], ALL_ROLES, ROLE_PERMISSIONS, "critic");
      expect(result.allowed).toBe(true);
    });

    it("allows research dispatch for research role", () => {
      const result = guardAgentDispatchPure(["role-research"], ALL_ROLES, ROLE_PERMISSIONS, "research");
      expect(result.allowed).toBe(true);
    });

    it("denies research dispatch for critic role (missing use_mcp)", () => {
      const result = guardAgentDispatchPure(["role-critic"], ALL_ROLES, ROLE_PERMISSIONS, "research");
      expect(result.allowed).toBe(false);
    });

    it("allows general dispatch for any agent role (inherits messages.send)", () => {
      const result = guardAgentDispatchPure(["role-critic"], ALL_ROLES, ROLE_PERMISSIONS, "general");
      expect(result.allowed).toBe(true);
    });

    it("skips check when disabled", () => {
      const config: GuardConfig = { enabled: false, log_denials: false, enforce: false };
      const result = guardAgentDispatchPure([], ALL_ROLES, ROLE_PERMISSIONS, "dev", config);
      expect(result.allowed).toBe(true);
    });

    it("logs but allows in audit mode (enforce=false)", () => {
      const config: GuardConfig = { enabled: true, log_denials: true, enforce: false };
      const result = guardAgentDispatchPure(["role-critic"], ALL_ROLES, ROLE_PERMISSIONS, "dev", config);
      expect(result.allowed).toBe(true); // not enforced
      expect(getRecentDenials().length).toBeGreaterThan(0); // but logged
    });
  });

  describe("guardToolExecution (with mock SQL)", () => {
    function mockSqlAllow(): any {
      let callIndex = 0;
      return function () {
        callIndex++;
        if (callIndex === 1) return Promise.resolve([{ role_id: "role-dev" }]);
        if (callIndex === 2) return Promise.resolve(ALL_ROLES);
        return Promise.resolve([{ resource: "tools", action: "use_bash", scope: null }]);
      };
    }

    function mockSqlDeny(): any {
      let callIndex = 0;
      return function () {
        callIndex++;
        if (callIndex === 1) return Promise.resolve([{ role_id: "role-critic" }]);
        if (callIndex === 2) return Promise.resolve(ALL_ROLES);
        return Promise.resolve([]); // no matching permissions
      };
    }

    it("allows bash for dev entity", async () => {
      const result = await guardToolExecution(mockSqlAllow(), "entity-dev", "bash");
      expect(result.allowed).toBe(true);
    });

    it("denies bash for critic entity", async () => {
      const result = await guardToolExecution(mockSqlDeny(), "entity-critic", "bash");
      expect(result.allowed).toBe(false);
      expect(result.denial!.action).toBe("use_bash");
    });

    it("allows unknown tools (passthrough)", async () => {
      const result = await guardToolExecution(mockSqlDeny(), "entity-any", "unknown_tool");
      expect(result.allowed).toBe(true);
    });
  });

  describe("guardWorkSession (with mock SQL)", () => {
    function mockSqlWithPerm(): any {
      let callIndex = 0;
      return function () {
        callIndex++;
        if (callIndex === 1) return Promise.resolve([{ role_id: "role-dev" }]);
        if (callIndex === 2) return Promise.resolve(ALL_ROLES);
        return Promise.resolve([{ resource: "plane", action: "update_issue", scope: null }]);
      };
    }

    function mockSqlNoPerm(): any {
      let callIndex = 0;
      return function () {
        callIndex++;
        if (callIndex === 1) return Promise.resolve([{ role_id: "role-research" }]);
        if (callIndex === 2) return Promise.resolve(ALL_ROLES);
        return Promise.resolve([]);
      };
    }

    it("allows start for entity with plane.update_issue", async () => {
      const result = await guardWorkSession(mockSqlWithPerm(), "entity-dev", "start");
      expect(result.allowed).toBe(true);
    });

    it("denies start for entity without plane.update_issue", async () => {
      const result = await guardWorkSession(mockSqlNoPerm(), "entity-research", "start");
      expect(result.allowed).toBe(false);
    });
  });

  describe("denial log", () => {
    it("records denials", () => {
      guardAgentDispatchPure(["role-critic"], ALL_ROLES, ROLE_PERMISSIONS, "dev");
      const denials = getRecentDenials();
      expect(denials.length).toBeGreaterThan(0);
      expect(denials[0].entity_id).toBe("pure-check");
    });

    it("limits log size", () => {
      for (let i = 0; i < 150; i++) {
        guardAgentDispatchPure(["role-critic"], ALL_ROLES, ROLE_PERMISSIONS, "dev");
      }
      expect(getRecentDenials(200).length).toBeLessThanOrEqual(100);
    });

    it("clears log", () => {
      guardAgentDispatchPure(["role-critic"], ALL_ROLES, ROLE_PERMISSIONS, "dev");
      clearDenialLog();
      expect(getRecentDenials()).toHaveLength(0);
    });
  });

  describe("formatDenialMessage", () => {
    it("formats a readable message", () => {
      const denial: PermissionDenial = {
        entity_id: "e1",
        resource: "tools",
        action: "use_bash",
        reason: 'Agent "dev" requires tools.use_bash',
        timestamp: "2026-03-16T12:00:00Z",
      };
      const msg = formatDenialMessage(denial);
      expect(msg).toContain("tools.use_bash");
      expect(msg).toContain("Permission denied");
    });
  });
});
