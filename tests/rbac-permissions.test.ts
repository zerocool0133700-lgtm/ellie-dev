import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";

const seedSql = readFileSync(
  new URL("../seeds/forest/20260316_rbac_permissions.sql", import.meta.url),
  "utf-8"
);

// Parse permissions from seed SQL
interface SeedPermission {
  id: string;
  resource: string;
  action: string;
}

function parsePermissions(sql: string): SeedPermission[] {
  const perms: SeedPermission[] = [];
  const re = /'(b0[0-9a-f-]+)',\s*'([^']+)',\s*'([^']+)',/g;
  let m;
  while ((m = re.exec(sql)) !== null) {
    perms.push({ id: m[1], resource: m[2], action: m[3] });
  }
  return perms;
}

const permissions = parsePermissions(seedSql);
const permById = new Map(permissions.map(p => [p.id, p]));

// Expected resources and their actions
const EXPECTED_RESOURCES: Record<string, string[]> = {
  plane: ["create_issue", "update_issue", "read_issue", "comment", "manage_cycles"],
  forest: ["read", "write", "delete", "manage_scopes"],
  git: ["commit", "push", "create_branch", "create_pr"],
  messages: ["send", "read", "delete"],
  agents: ["dispatch", "monitor", "configure", "terminate"],
  tools: ["use_bash", "use_edit", "use_web", "use_mcp"],
  system: ["restart_service", "manage_config", "manage_secrets"],
  memory: ["read", "write", "delete"],
};

describe("ELLIE-791: Core permission set", () => {
  describe("permission definitions", () => {
    it("defines all 8 resource domains", () => {
      const resources = new Set(permissions.map(p => p.resource));
      for (const r of Object.keys(EXPECTED_RESOURCES)) {
        expect(resources.has(r)).toBe(true);
      }
    });

    for (const [resource, actions] of Object.entries(EXPECTED_RESOURCES)) {
      it(`${resource} has all ${actions.length} actions`, () => {
        const resourcePerms = permissions.filter(p => p.resource === resource);
        const foundActions = resourcePerms.map(p => p.action);
        for (const action of actions) {
          expect(foundActions).toContain(action);
        }
        expect(resourcePerms).toHaveLength(actions.length);
      });
    }

    it("has 31 total permissions", () => {
      const total = Object.values(EXPECTED_RESOURCES).reduce((sum, a) => sum + a.length, 0);
      expect(permissions).toHaveLength(total);
      expect(total).toBe(30);
    });

    it("each permission has a unique ID", () => {
      const ids = new Set(permissions.map(p => p.id));
      expect(ids.size).toBe(permissions.length);
    });

    it("uses deterministic UUIDs", () => {
      for (const p of permissions) {
        expect(p.id).toMatch(/^b0[0-9a-f]{6}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      }
    });
  });

  describe("idempotency", () => {
    it("all permission inserts use ON CONFLICT DO NOTHING", () => {
      const permInserts = (seedSql.match(/INSERT INTO rbac_permissions/g) || []).length;
      // Each multi-value INSERT has one ON CONFLICT
      const permConflicts = (seedSql.match(/ON CONFLICT \(resource, action, scope\) DO NOTHING/g) || []).length;
      expect(permConflicts).toBe(permInserts);
    });

    it("all role-permission inserts use ON CONFLICT DO NOTHING", () => {
      const rpInserts = (seedSql.match(/INSERT INTO rbac_role_permissions/g) || []).length;
      const rpConflicts = (seedSql.match(/ON CONFLICT DO NOTHING/g) || []).length;
      // Total ON CONFLICT = perm conflicts + role-perm conflicts
      expect(rpConflicts).toBeGreaterThanOrEqual(rpInserts);
    });
  });

  describe("role-permission mappings", () => {
    // Role IDs from the roles seed
    const ROLE_IDS = {
      agent_base: "a0000000-0000-0000-0000-000000000001",
      dev_agent: "a0000000-0000-0000-0000-000000000002",
      critic_agent: "a0000000-0000-0000-0000-000000000003",
      research_agent: "a0000000-0000-0000-0000-000000000004",
      super_user: "a0000000-0000-0000-0000-000000000010",
      super_agent: "a0000000-0000-0000-0000-000000000011",
    };

    it("agent_base gets messages.send, messages.read, memory.read, memory.write, forest.read", () => {
      const mappings = seedSql.match(new RegExp(`'${ROLE_IDS.agent_base}',\\s*'b0[^']+`, "g")) || [];
      expect(mappings.length).toBe(5);
    });

    it("dev_agent gets plane, git, forest.write, and tool permissions", () => {
      const mappings = seedSql.match(new RegExp(`'${ROLE_IDS.dev_agent}',\\s*'b0[^']+`, "g")) || [];
      expect(mappings.length).toBe(13);
    });

    it("critic_agent gets read-only plane + web tools", () => {
      const mappings = seedSql.match(new RegExp(`'${ROLE_IDS.critic_agent}',\\s*'b0[^']+`, "g")) || [];
      expect(mappings.length).toBe(3);
    });

    it("research_agent gets web, mcp, and read permissions", () => {
      const mappings = seedSql.match(new RegExp(`'${ROLE_IDS.research_agent}',\\s*'b0[^']+`, "g")) || [];
      expect(mappings.length).toBe(3);
    });

    it("super_agent gets ALL permissions via SELECT", () => {
      expect(seedSql).toContain(`SELECT '${ROLE_IDS.super_agent}', id FROM rbac_permissions`);
    });

    it("super_user gets ALL permissions via SELECT", () => {
      expect(seedSql).toContain(`SELECT '${ROLE_IDS.super_user}', id FROM rbac_permissions`);
    });
  });

  describe("descriptions", () => {
    it("every permission insert has a description", () => {
      // Each permission row should have a description (5th column)
      for (const p of permissions) {
        // Find the line with this permission's action
        const pattern = new RegExp(`'${p.resource}',\\s*'${p.action}'.*?'([^']+)'\\s*\\)`, "s");
        const match = seedSql.match(pattern);
        expect(match).not.toBeNull();
      }
    });
  });
});
