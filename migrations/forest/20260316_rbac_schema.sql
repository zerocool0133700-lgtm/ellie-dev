-- ELLIE-789: Hierarchical RBAC entity/permission schema
-- Foundational tables for role-based access control in the Forest database.

-- Entity types
DO $$ BEGIN
  CREATE TYPE entity_type AS ENUM ('user', 'super_agent', 'agent');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Entities (users, agents, super_agents)
CREATE TABLE IF NOT EXISTS rbac_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type entity_type NOT NULL,
  name TEXT NOT NULL,
  archetype TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rbac_entities_type ON rbac_entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_rbac_entities_name ON rbac_entities(name);

-- Roles (with self-referencing FK for inheritance)
CREATE TABLE IF NOT EXISTS rbac_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  parent_role_id UUID REFERENCES rbac_roles(id) ON DELETE SET NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rbac_roles_parent ON rbac_roles(parent_role_id);

-- Permissions
CREATE TABLE IF NOT EXISTS rbac_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource TEXT NOT NULL,
  action TEXT NOT NULL,
  scope TEXT,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(resource, action, scope)
);

CREATE INDEX IF NOT EXISTS idx_rbac_permissions_resource ON rbac_permissions(resource);
CREATE INDEX IF NOT EXISTS idx_rbac_permissions_resource_action ON rbac_permissions(resource, action);

-- Role-Permission mapping (many-to-many)
CREATE TABLE IF NOT EXISTS rbac_role_permissions (
  role_id UUID NOT NULL REFERENCES rbac_roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES rbac_permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- Entity-Role mapping (many-to-many)
CREATE TABLE IF NOT EXISTS rbac_entity_roles (
  entity_id UUID NOT NULL REFERENCES rbac_entities(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES rbac_roles(id) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by UUID REFERENCES rbac_entities(id) ON DELETE SET NULL,
  PRIMARY KEY (entity_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_rbac_entity_roles_entity ON rbac_entity_roles(entity_id);
CREATE INDEX IF NOT EXISTS idx_rbac_entity_roles_role ON rbac_entity_roles(role_id);

-- Updated_at triggers
CREATE OR REPLACE FUNCTION update_rbac_entities_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rbac_entities_updated_at ON rbac_entities;
CREATE TRIGGER trg_rbac_entities_updated_at
  BEFORE UPDATE ON rbac_entities
  FOR EACH ROW EXECUTE FUNCTION update_rbac_entities_updated_at();
