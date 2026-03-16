import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";

const migrationSql = readFileSync(
  new URL("../migrations/forest/20260316_rbac_schema.sql", import.meta.url),
  "utf-8"
);

describe("ELLIE-789: RBAC entity/permission schema", () => {
  describe("entity_type enum", () => {
    it("creates entity_type enum", () => {
      expect(migrationSql).toContain("CREATE TYPE entity_type AS ENUM");
    });

    it("includes all three entity types", () => {
      expect(migrationSql).toContain("'user'");
      expect(migrationSql).toContain("'super_agent'");
      expect(migrationSql).toContain("'agent'");
    });

    it("handles duplicate enum gracefully", () => {
      expect(migrationSql).toContain("EXCEPTION WHEN duplicate_object THEN NULL");
    });
  });

  describe("rbac_entities table", () => {
    it("creates the table", () => {
      expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS rbac_entities");
    });

    it("has UUID primary key", () => {
      expect(migrationSql).toContain("id UUID PRIMARY KEY DEFAULT gen_random_uuid()");
    });

    it("has entity_type column", () => {
      expect(migrationSql).toContain("entity_type entity_type NOT NULL");
    });

    it("has name column", () => {
      expect(migrationSql).toContain("name TEXT NOT NULL");
    });

    it("has nullable archetype", () => {
      expect(migrationSql).toMatch(/archetype TEXT[,\s]/);
    });

    it("has metadata JSONB", () => {
      expect(migrationSql).toContain("metadata JSONB DEFAULT '{}'");
    });

    it("has timestamp columns", () => {
      expect(migrationSql).toMatch(/created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
    });

    it("has index on entity_type", () => {
      expect(migrationSql).toContain("idx_rbac_entities_type ON rbac_entities(entity_type)");
    });

    it("has index on name", () => {
      expect(migrationSql).toContain("idx_rbac_entities_name ON rbac_entities(name)");
    });
  });

  describe("rbac_roles table", () => {
    it("creates the table", () => {
      expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS rbac_roles");
    });

    it("has unique name", () => {
      expect(migrationSql).toContain("name TEXT NOT NULL UNIQUE");
    });

    it("has self-referencing parent_role_id FK", () => {
      expect(migrationSql).toContain("parent_role_id UUID REFERENCES rbac_roles(id)");
    });

    it("sets parent to NULL on delete", () => {
      expect(migrationSql).toContain("ON DELETE SET NULL");
    });

    it("has index on parent_role_id", () => {
      expect(migrationSql).toContain("idx_rbac_roles_parent ON rbac_roles(parent_role_id)");
    });
  });

  describe("rbac_permissions table", () => {
    it("creates the table", () => {
      expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS rbac_permissions");
    });

    it("has resource and action columns", () => {
      expect(migrationSql).toContain("resource TEXT NOT NULL");
      expect(migrationSql).toContain("action TEXT NOT NULL");
    });

    it("has nullable scope column", () => {
      expect(migrationSql).toMatch(/scope TEXT[,\s]/);
    });

    it("has unique constraint on resource+action+scope", () => {
      expect(migrationSql).toContain("UNIQUE(resource, action, scope)");
    });

    it("has index on resource", () => {
      expect(migrationSql).toContain("idx_rbac_permissions_resource ON rbac_permissions(resource)");
    });

    it("has composite index on resource+action", () => {
      expect(migrationSql).toContain("idx_rbac_permissions_resource_action ON rbac_permissions(resource, action)");
    });
  });

  describe("rbac_role_permissions junction table", () => {
    it("creates the table", () => {
      expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS rbac_role_permissions");
    });

    it("has composite primary key", () => {
      expect(migrationSql).toContain("PRIMARY KEY (role_id, permission_id)");
    });

    it("has FK to roles with CASCADE delete", () => {
      expect(migrationSql).toContain("role_id UUID NOT NULL REFERENCES rbac_roles(id) ON DELETE CASCADE");
    });

    it("has FK to permissions with CASCADE delete", () => {
      expect(migrationSql).toContain("permission_id UUID NOT NULL REFERENCES rbac_permissions(id) ON DELETE CASCADE");
    });
  });

  describe("rbac_entity_roles junction table", () => {
    it("creates the table", () => {
      expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS rbac_entity_roles");
    });

    it("has composite primary key", () => {
      expect(migrationSql).toContain("PRIMARY KEY (entity_id, role_id)");
    });

    it("has FK to entities with CASCADE delete", () => {
      expect(migrationSql).toContain("entity_id UUID NOT NULL REFERENCES rbac_entities(id) ON DELETE CASCADE");
    });

    it("has FK to roles with CASCADE delete", () => {
      expect(migrationSql).toMatch(/role_id UUID NOT NULL REFERENCES rbac_roles\(id\) ON DELETE CASCADE/);
    });

    it("has granted_at timestamp", () => {
      expect(migrationSql).toContain("granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
    });

    it("has granted_by FK to entities", () => {
      expect(migrationSql).toContain("granted_by UUID REFERENCES rbac_entities(id)");
    });

    it("has indexes on entity_id and role_id", () => {
      expect(migrationSql).toContain("idx_rbac_entity_roles_entity ON rbac_entity_roles(entity_id)");
      expect(migrationSql).toContain("idx_rbac_entity_roles_role ON rbac_entity_roles(role_id)");
    });
  });

  describe("updated_at trigger", () => {
    it("creates trigger function", () => {
      expect(migrationSql).toContain("CREATE OR REPLACE FUNCTION update_rbac_entities_updated_at()");
    });

    it("creates BEFORE UPDATE trigger", () => {
      expect(migrationSql).toContain("BEFORE UPDATE ON rbac_entities");
    });
  });
});
