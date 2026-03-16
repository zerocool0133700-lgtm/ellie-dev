import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { checkPermissionPure, type Role, type Permission } from "../src/permissions.ts";

const seedSql = readFileSync(
  new URL("../seeds/forest/20260316_rbac_entity_brian.sql", import.meta.url),
  "utf-8"
);

const BRIAN_ID = "e0000000-0000-0000-0000-000000000004";
const CRITIC_AGENT_ROLE = "a0000000-0000-0000-0000-000000000003";
const ELLIE_ID = "e0000000-0000-0000-0000-000000000002";

const ALL_ROLES: Role[] = [
  { id: "a0000000-0000-0000-0000-000000000001", name: "agent_base", parent_role_id: null },
  { id: "a0000000-0000-0000-0000-000000000002", name: "dev_agent", parent_role_id: "a0000000-0000-0000-0000-000000000001" },
  { id: "a0000000-0000-0000-0000-000000000003", name: "critic_agent", parent_role_id: "a0000000-0000-0000-0000-000000000001" },
];

const ROLE_PERMISSIONS = new Map<string, Permission[]>([
  ["a0000000-0000-0000-0000-000000000001", [
    { id: "p1", resource: "messages", action: "send", scope: null },
    { id: "p2", resource: "messages", action: "read", scope: null },
    { id: "p3", resource: "memory", action: "read", scope: null },
    { id: "p4", resource: "forest", action: "read", scope: null },
  ]],
  ["a0000000-0000-0000-0000-000000000003", [
    { id: "p20", resource: "plane", action: "read_issue", scope: null },
    { id: "p21", resource: "plane", action: "comment", scope: null },
    { id: "p22", resource: "tools", action: "use_web", scope: null },
  ]],
]);

describe("ELLIE-796: Brian critic agent entity", () => {
  describe("seed file", () => {
    it("creates Brian with agent type", () => {
      expect(seedSql).toContain(`'${BRIAN_ID}'`);
      expect(seedSql).toContain("'agent'");
      expect(seedSql).toContain("'Brian'");
    });

    it("has critic archetype", () => {
      expect(seedSql).toContain("'critic'");
    });

    it("metadata includes review capabilities", () => {
      expect(seedSql).toContain("review");
      expect(seedSql).toContain("feedback");
      expect(seedSql).toContain("quality_checks");
    });

    it("metadata includes domain scoping info", () => {
      expect(seedSql).toContain("ellie-dev");
      expect(seedSql).toContain("ellie-home");
      expect(seedSql).toContain("domain_note");
    });

    it("assigns critic_agent role", () => {
      expect(seedSql).toContain(`'${CRITIC_AGENT_ROLE}'`);
    });

    it("role granted by Ellie", () => {
      expect(seedSql).toContain(`'${ELLIE_ID}'`);
    });

    it("is idempotent", () => {
      expect(seedSql).toContain("ON CONFLICT (id) DO NOTHING");
      expect(seedSql).toContain("ON CONFLICT (entity_id, role_id) DO NOTHING");
    });
  });

  describe("permissions Brian CAN do", () => {
    const brianRoles = [CRITIC_AGENT_ROLE];

    it("can read Plane issues", () => {
      expect(checkPermissionPure(brianRoles, ALL_ROLES, ROLE_PERMISSIONS, "plane", "read_issue")).toBe(true);
    });

    it("can comment on Plane issues", () => {
      expect(checkPermissionPure(brianRoles, ALL_ROLES, ROLE_PERMISSIONS, "plane", "comment")).toBe(true);
    });

    it("can use web tools", () => {
      expect(checkPermissionPure(brianRoles, ALL_ROLES, ROLE_PERMISSIONS, "tools", "use_web")).toBe(true);
    });

    it("can send messages (inherited)", () => {
      expect(checkPermissionPure(brianRoles, ALL_ROLES, ROLE_PERMISSIONS, "messages", "send")).toBe(true);
    });

    it("can read messages (inherited)", () => {
      expect(checkPermissionPure(brianRoles, ALL_ROLES, ROLE_PERMISSIONS, "messages", "read")).toBe(true);
    });

    it("can read memory (inherited)", () => {
      expect(checkPermissionPure(brianRoles, ALL_ROLES, ROLE_PERMISSIONS, "memory", "read")).toBe(true);
    });

    it("can read forest (inherited)", () => {
      expect(checkPermissionPure(brianRoles, ALL_ROLES, ROLE_PERMISSIONS, "forest", "read")).toBe(true);
    });
  });

  describe("permissions Brian CANNOT do", () => {
    const brianRoles = [CRITIC_AGENT_ROLE];

    it("cannot commit code", () => {
      expect(checkPermissionPure(brianRoles, ALL_ROLES, ROLE_PERMISSIONS, "git", "commit")).toBe(false);
    });

    it("cannot push code", () => {
      expect(checkPermissionPure(brianRoles, ALL_ROLES, ROLE_PERMISSIONS, "git", "push")).toBe(false);
    });

    it("cannot create PRs", () => {
      expect(checkPermissionPure(brianRoles, ALL_ROLES, ROLE_PERMISSIONS, "git", "create_pr")).toBe(false);
    });

    it("cannot dispatch agents", () => {
      expect(checkPermissionPure(brianRoles, ALL_ROLES, ROLE_PERMISSIONS, "agents", "dispatch")).toBe(false);
    });

    it("cannot use bash", () => {
      expect(checkPermissionPure(brianRoles, ALL_ROLES, ROLE_PERMISSIONS, "tools", "use_bash")).toBe(false);
    });

    it("cannot update Plane issues", () => {
      expect(checkPermissionPure(brianRoles, ALL_ROLES, ROLE_PERMISSIONS, "plane", "update_issue")).toBe(false);
    });

    it("cannot restart services", () => {
      expect(checkPermissionPure(brianRoles, ALL_ROLES, ROLE_PERMISSIONS, "system", "restart_service")).toBe(false);
    });

    it("cannot manage secrets", () => {
      expect(checkPermissionPure(brianRoles, ALL_ROLES, ROLE_PERMISSIONS, "system", "manage_secrets")).toBe(false);
    });
  });
});
