import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { checkPermissionPure, resolveRoleTree, type Role, type Permission } from "../src/permissions.ts";

const seedSql = readFileSync(
  new URL("../seeds/forest/20260316_rbac_entity_james.sql", import.meta.url),
  "utf-8"
);

const JAMES_ID = "e0000000-0000-0000-0000-000000000003";
const DEV_AGENT_ROLE = "a0000000-0000-0000-0000-000000000002";
const ELLIE_ID = "e0000000-0000-0000-0000-000000000002";

// Full role + permission data matching seeds
const ALL_ROLES: Role[] = [
  { id: "a0000000-0000-0000-0000-000000000001", name: "agent_base", parent_role_id: null },
  { id: "a0000000-0000-0000-0000-000000000002", name: "dev_agent", parent_role_id: "a0000000-0000-0000-0000-000000000001" },
  { id: "a0000000-0000-0000-0000-000000000003", name: "critic_agent", parent_role_id: "a0000000-0000-0000-0000-000000000001" },
  { id: "a0000000-0000-0000-0000-000000000010", name: "super_user", parent_role_id: null },
  { id: "a0000000-0000-0000-0000-000000000011", name: "super_agent", parent_role_id: "a0000000-0000-0000-0000-000000000001" },
];

const ROLE_PERMISSIONS = new Map<string, Permission[]>([
  ["a0000000-0000-0000-0000-000000000001", [
    { id: "p1", resource: "messages", action: "send", scope: null },
    { id: "p2", resource: "messages", action: "read", scope: null },
    { id: "p3", resource: "memory", action: "read", scope: null },
    { id: "p4", resource: "memory", action: "write", scope: null },
    { id: "p5", resource: "forest", action: "read", scope: null },
  ]],
  ["a0000000-0000-0000-0000-000000000002", [
    { id: "p10", resource: "plane", action: "create_issue", scope: null },
    { id: "p11", resource: "plane", action: "update_issue", scope: null },
    { id: "p12", resource: "plane", action: "read_issue", scope: null },
    { id: "p13", resource: "plane", action: "comment", scope: null },
    { id: "p14", resource: "git", action: "commit", scope: null },
    { id: "p15", resource: "git", action: "push", scope: null },
    { id: "p16", resource: "git", action: "create_branch", scope: null },
    { id: "p17", resource: "git", action: "create_pr", scope: null },
    { id: "p18", resource: "forest", action: "write", scope: null },
    { id: "p19", resource: "tools", action: "use_bash", scope: null },
    { id: "p20", resource: "tools", action: "use_edit", scope: null },
    { id: "p21", resource: "tools", action: "use_mcp", scope: null },
  ]],
]);

describe("ELLIE-795: James dev agent entity", () => {
  describe("seed file", () => {
    it("creates James entity with agent type", () => {
      expect(seedSql).toContain(`'${JAMES_ID}'`);
      expect(seedSql).toContain("'agent'");
      expect(seedSql).toContain("'James'");
    });

    it("James has dev archetype", () => {
      expect(seedSql).toContain("'dev'");
    });

    it("metadata notes archetype is not a capability limit", () => {
      expect(seedSql).toContain("archetype_note");
      expect(seedSql).toContain("not capability limit");
    });

    it("metadata includes capabilities", () => {
      expect(seedSql).toContain("code");
      expect(seedSql).toContain("git");
      expect(seedSql).toContain("plane");
      expect(seedSql).toContain("config");
      expect(seedSql).toContain("service_management");
    });

    it("assigns dev_agent role", () => {
      expect(seedSql).toContain(`'${DEV_AGENT_ROLE}'`);
    });

    it("role granted by Ellie", () => {
      expect(seedSql).toContain(`'${ELLIE_ID}'`);
    });

    it("is idempotent", () => {
      expect(seedSql).toContain("ON CONFLICT (id) DO NOTHING");
      expect(seedSql).toContain("ON CONFLICT (entity_id, role_id) DO NOTHING");
    });
  });

  describe("permission checks (via dev_agent + agent_base inheritance)", () => {
    const jamesRoles = [DEV_AGENT_ROLE];

    // Dev work James CAN do
    it("can commit to git", () => {
      expect(checkPermissionPure(jamesRoles, ALL_ROLES, ROLE_PERMISSIONS, "git", "commit")).toBe(true);
    });

    it("can push to git", () => {
      expect(checkPermissionPure(jamesRoles, ALL_ROLES, ROLE_PERMISSIONS, "git", "push")).toBe(true);
    });

    it("can create branches", () => {
      expect(checkPermissionPure(jamesRoles, ALL_ROLES, ROLE_PERMISSIONS, "git", "create_branch")).toBe(true);
    });

    it("can create PRs", () => {
      expect(checkPermissionPure(jamesRoles, ALL_ROLES, ROLE_PERMISSIONS, "git", "create_pr")).toBe(true);
    });

    it("can read Plane issues", () => {
      expect(checkPermissionPure(jamesRoles, ALL_ROLES, ROLE_PERMISSIONS, "plane", "read_issue")).toBe(true);
    });

    it("can update Plane issues", () => {
      expect(checkPermissionPure(jamesRoles, ALL_ROLES, ROLE_PERMISSIONS, "plane", "update_issue")).toBe(true);
    });

    it("can comment on Plane issues", () => {
      expect(checkPermissionPure(jamesRoles, ALL_ROLES, ROLE_PERMISSIONS, "plane", "comment")).toBe(true);
    });

    it("can use bash", () => {
      expect(checkPermissionPure(jamesRoles, ALL_ROLES, ROLE_PERMISSIONS, "tools", "use_bash")).toBe(true);
    });

    it("can use edit", () => {
      expect(checkPermissionPure(jamesRoles, ALL_ROLES, ROLE_PERMISSIONS, "tools", "use_edit")).toBe(true);
    });

    it("can write to forest", () => {
      expect(checkPermissionPure(jamesRoles, ALL_ROLES, ROLE_PERMISSIONS, "forest", "write")).toBe(true);
    });

    // Inherited from agent_base
    it("can send messages (inherited)", () => {
      expect(checkPermissionPure(jamesRoles, ALL_ROLES, ROLE_PERMISSIONS, "messages", "send")).toBe(true);
    });

    it("can read messages (inherited)", () => {
      expect(checkPermissionPure(jamesRoles, ALL_ROLES, ROLE_PERMISSIONS, "messages", "read")).toBe(true);
    });

    it("can read memory (inherited)", () => {
      expect(checkPermissionPure(jamesRoles, ALL_ROLES, ROLE_PERMISSIONS, "memory", "read")).toBe(true);
    });

    it("can write memory (inherited)", () => {
      expect(checkPermissionPure(jamesRoles, ALL_ROLES, ROLE_PERMISSIONS, "memory", "write")).toBe(true);
    });

    it("can read forest (inherited)", () => {
      expect(checkPermissionPure(jamesRoles, ALL_ROLES, ROLE_PERMISSIONS, "forest", "read")).toBe(true);
    });

    // Things James CANNOT do
    it("cannot dispatch agents", () => {
      expect(checkPermissionPure(jamesRoles, ALL_ROLES, ROLE_PERMISSIONS, "agents", "dispatch")).toBe(false);
    });

    it("cannot terminate agents", () => {
      expect(checkPermissionPure(jamesRoles, ALL_ROLES, ROLE_PERMISSIONS, "agents", "terminate")).toBe(false);
    });

    it("cannot restart services", () => {
      expect(checkPermissionPure(jamesRoles, ALL_ROLES, ROLE_PERMISSIONS, "system", "restart_service")).toBe(false);
    });

    it("cannot manage secrets", () => {
      expect(checkPermissionPure(jamesRoles, ALL_ROLES, ROLE_PERMISSIONS, "system", "manage_secrets")).toBe(false);
    });

    it("cannot manage config", () => {
      expect(checkPermissionPure(jamesRoles, ALL_ROLES, ROLE_PERMISSIONS, "system", "manage_config")).toBe(false);
    });
  });

  describe("role inheritance", () => {
    it("dev_agent inherits from agent_base", () => {
      const tree = resolveRoleTree(DEV_AGENT_ROLE, ALL_ROLES);
      expect(tree).toContain(DEV_AGENT_ROLE);
      expect(tree).toContain("a0000000-0000-0000-0000-000000000001"); // agent_base
    });
  });
});
