import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";

const seedSql = readFileSync(
  new URL("../seeds/forest/20260316_rbac_entities.sql", import.meta.url),
  "utf-8"
);

const DAVE_ID = "e0000000-0000-0000-0000-000000000001";
const ELLIE_ID = "e0000000-0000-0000-0000-000000000002";
const SUPER_USER_ROLE = "a0000000-0000-0000-0000-000000000010";
const SUPER_AGENT_ROLE = "a0000000-0000-0000-0000-000000000011";

describe("ELLIE-792: Seed Dave and Ellie as initial entities", () => {
  describe("Dave entity", () => {
    it("creates Dave with user entity_type", () => {
      expect(seedSql).toContain(`'${DAVE_ID}'`);
      expect(seedSql).toContain("'user'");
      expect(seedSql).toContain("'Dave'");
    });

    it("Dave has no archetype", () => {
      // The NULL appears between 'Dave' and the metadata jsonb
      const daveInsert = seedSql.substring(
        seedSql.indexOf(DAVE_ID),
        seedSql.indexOf("ON CONFLICT", seedSql.indexOf(DAVE_ID))
      );
      expect(daveInsert).toContain("NULL");
    });

    it("Dave has timezone in metadata", () => {
      expect(seedSql).toContain("America/Chicago");
    });

    it("Dave has dyslexia_mode preference", () => {
      expect(seedSql).toContain("dyslexia_mode");
    });

    it("Dave has audio_first preference", () => {
      expect(seedSql).toContain("audio_first");
    });
  });

  describe("Ellie entity", () => {
    it("creates Ellie with super_agent entity_type", () => {
      expect(seedSql).toContain(`'${ELLIE_ID}'`);
      expect(seedSql).toContain("'super_agent'");
      expect(seedSql).toContain("'Ellie'");
    });

    it("Ellie has orchestrator archetype", () => {
      expect(seedSql).toContain("'orchestrator'");
    });

    it("Ellie has capabilities in metadata", () => {
      expect(seedSql).toContain("orchestrate");
      expect(seedSql).toContain("dispatch");
      expect(seedSql).toContain("plan");
      expect(seedSql).toContain("execute");
    });

    it("Ellie has governance rules", () => {
      expect(seedSql).toContain("speak_for_dave");
      expect(seedSql).toContain("commit_dave");
      expect(seedSql).toContain("partnership");
    });

    it("governance prevents speaking for Dave", () => {
      expect(seedSql).toContain('"speak_for_dave": false');
    });

    it("governance prevents committing Dave", () => {
      expect(seedSql).toContain('"commit_dave": false');
    });
  });

  describe("role assignments", () => {
    it("assigns Dave to super_user role", () => {
      expect(seedSql).toContain(`'${DAVE_ID}'`);
      expect(seedSql).toContain(`'${SUPER_USER_ROLE}'`);
    });

    it("assigns Ellie to super_agent role", () => {
      expect(seedSql).toContain(`'${ELLIE_ID}'`);
      expect(seedSql).toContain(`'${SUPER_AGENT_ROLE}'`);
    });

    it("Ellie's role was granted by Dave", () => {
      // The entity_roles insert for Ellie has granted_by = Dave's ID
      const ellieRoleInsert = seedSql.substring(
        seedSql.lastIndexOf("INSERT INTO rbac_entity_roles"),
      );
      expect(ellieRoleInsert).toContain(ELLIE_ID);
      expect(ellieRoleInsert).toContain(DAVE_ID);
    });

    it("Dave's role has no granted_by (bootstrapped)", () => {
      // First entity_roles insert has NULL granted_by
      const firstInsert = seedSql.substring(
        seedSql.indexOf("INSERT INTO rbac_entity_roles"),
        seedSql.indexOf("ON CONFLICT", seedSql.indexOf("INSERT INTO rbac_entity_roles")) + 50,
      );
      expect(firstInsert).toContain("NULL");
    });
  });

  describe("idempotency", () => {
    it("entity inserts use ON CONFLICT DO NOTHING", () => {
      const entityInserts = (seedSql.match(/INSERT INTO rbac_entities/g) || []).length;
      const entityConflicts = (seedSql.match(/ON CONFLICT \(id\) DO NOTHING/g) || []).length;
      expect(entityConflicts).toBe(entityInserts);
    });

    it("role assignment inserts use ON CONFLICT DO NOTHING", () => {
      const roleInserts = (seedSql.match(/INSERT INTO rbac_entity_roles/g) || []).length;
      const roleConflicts = (seedSql.match(/ON CONFLICT \(entity_id, role_id\) DO NOTHING/g) || []).length;
      expect(roleConflicts).toBe(roleInserts);
    });
  });

  describe("referential integrity", () => {
    it("entity IDs are valid UUIDs", () => {
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      expect(DAVE_ID).toMatch(uuidRe);
      expect(ELLIE_ID).toMatch(uuidRe);
    });

    it("role IDs reference the roles seed", () => {
      // These IDs must match 20260316_rbac_roles.sql
      expect(SUPER_USER_ROLE).toBe("a0000000-0000-0000-0000-000000000010");
      expect(SUPER_AGENT_ROLE).toBe("a0000000-0000-0000-0000-000000000011");
    });
  });
});
