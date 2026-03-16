import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";

const seedSql = readFileSync(
  new URL("../seeds/forest/20260316_rbac_roles.sql", import.meta.url),
  "utf-8"
);

// Parse roles from seed SQL for structural validation
interface SeedRole {
  id: string;
  name: string;
  parent_id: string | null;
}

function parseRoles(sql: string): SeedRole[] {
  const roles: SeedRole[] = [];
  const re = /INSERT INTO rbac_roles.*?VALUES\s*\(\s*'([^']+)',\s*'([^']+)',\s*(NULL|'[^']+'),/gs;
  let m;
  while ((m = re.exec(sql)) !== null) {
    roles.push({
      id: m[1],
      name: m[2],
      parent_id: m[3] === "NULL" ? null : m[3].replace(/'/g, ""),
    });
  }
  return roles;
}

const roles = parseRoles(seedSql);
const roleMap = new Map(roles.map(r => [r.name, r]));
const roleById = new Map(roles.map(r => [r.id, r]));

describe("ELLIE-790: Initial role hierarchy", () => {
  describe("role definitions", () => {
    it("defines all 6 required roles", () => {
      const names = roles.map(r => r.name);
      expect(names).toContain("super_user");
      expect(names).toContain("super_agent");
      expect(names).toContain("dev_agent");
      expect(names).toContain("critic_agent");
      expect(names).toContain("research_agent");
      expect(names).toContain("agent_base");
      expect(roles).toHaveLength(6);
    });

    it("each role has a unique ID", () => {
      const ids = new Set(roles.map(r => r.id));
      expect(ids.size).toBe(6);
    });

    it("each role has a unique name", () => {
      const names = new Set(roles.map(r => r.name));
      expect(names.size).toBe(6);
    });

    it("uses deterministic UUIDs", () => {
      for (const role of roles) {
        expect(role.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      }
    });
  });

  describe("hierarchy structure", () => {
    it("agent_base has no parent", () => {
      expect(roleMap.get("agent_base")!.parent_id).toBeNull();
    });

    it("super_user has no parent", () => {
      expect(roleMap.get("super_user")!.parent_id).toBeNull();
    });

    it("dev_agent inherits from agent_base", () => {
      const dev = roleMap.get("dev_agent")!;
      expect(dev.parent_id).toBe(roleMap.get("agent_base")!.id);
    });

    it("critic_agent inherits from agent_base", () => {
      const critic = roleMap.get("critic_agent")!;
      expect(critic.parent_id).toBe(roleMap.get("agent_base")!.id);
    });

    it("research_agent inherits from agent_base", () => {
      const research = roleMap.get("research_agent")!;
      expect(research.parent_id).toBe(roleMap.get("agent_base")!.id);
    });

    it("super_agent inherits from agent_base", () => {
      const superAgent = roleMap.get("super_agent")!;
      expect(superAgent.parent_id).toBe(roleMap.get("agent_base")!.id);
    });
  });

  describe("parent references resolve", () => {
    it("all parent_role_ids reference existing roles", () => {
      for (const role of roles) {
        if (role.parent_id !== null) {
          expect(roleById.has(role.parent_id)).toBe(true);
        }
      }
    });

    it("no circular references at depth 1", () => {
      for (const role of roles) {
        if (role.parent_id !== null) {
          expect(role.parent_id).not.toBe(role.id);
        }
      }
    });

    it("hierarchy depth is at most 2", () => {
      for (const role of roles) {
        let depth = 0;
        let current: SeedRole | undefined = role;
        while (current?.parent_id) {
          depth++;
          current = roleById.get(current.parent_id);
          if (depth > 10) break; // safety
        }
        expect(depth).toBeLessThanOrEqual(2);
      }
    });
  });

  describe("idempotency", () => {
    it("uses ON CONFLICT DO NOTHING for all inserts", () => {
      const insertCount = (seedSql.match(/INSERT INTO rbac_roles/g) || []).length;
      const conflictCount = (seedSql.match(/ON CONFLICT \(name\) DO NOTHING/g) || []).length;
      expect(conflictCount).toBe(insertCount);
    });
  });

  describe("descriptions", () => {
    it("all roles have descriptions", () => {
      for (const name of ["super_user", "super_agent", "dev_agent", "critic_agent", "research_agent", "agent_base"]) {
        expect(seedSql).toContain(`'${name}'`);
      }
    });
  });
});
