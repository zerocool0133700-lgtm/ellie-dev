-- ELLIE-819: RBAC schema hardening
-- Fixes critical review findings from ELLIE-788 epic.

-- 1. Add UNIQUE constraint on rbac_entities.name (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rbac_entities_name_unique'
  ) THEN
    ALTER TABLE rbac_entities ADD CONSTRAINT rbac_entities_name_unique UNIQUE (name);
  END IF;
END $$;

-- 2. Missing indexes for reverse lookups and audit queries
CREATE INDEX IF NOT EXISTS idx_rbac_role_permissions_permission ON rbac_role_permissions(permission_id);
CREATE INDEX IF NOT EXISTS idx_rbac_entity_roles_granted_by ON rbac_entity_roles(granted_by);

-- 3. Change CASCADE DELETE to RESTRICT on critical foreign keys
-- Drop and recreate role_permissions FKs as RESTRICT
ALTER TABLE rbac_role_permissions DROP CONSTRAINT IF EXISTS rbac_role_permissions_role_id_fkey;
ALTER TABLE rbac_role_permissions ADD CONSTRAINT rbac_role_permissions_role_id_fkey
  FOREIGN KEY (role_id) REFERENCES rbac_roles(id) ON DELETE RESTRICT;

ALTER TABLE rbac_role_permissions DROP CONSTRAINT IF EXISTS rbac_role_permissions_permission_id_fkey;
ALTER TABLE rbac_role_permissions ADD CONSTRAINT rbac_role_permissions_permission_id_fkey
  FOREIGN KEY (permission_id) REFERENCES rbac_permissions(id) ON DELETE RESTRICT;

-- Drop and recreate entity_roles FKs as RESTRICT (except granted_by which stays SET NULL)
ALTER TABLE rbac_entity_roles DROP CONSTRAINT IF EXISTS rbac_entity_roles_entity_id_fkey;
ALTER TABLE rbac_entity_roles ADD CONSTRAINT rbac_entity_roles_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES rbac_entities(id) ON DELETE RESTRICT;

ALTER TABLE rbac_entity_roles DROP CONSTRAINT IF EXISTS rbac_entity_roles_role_id_fkey;
ALTER TABLE rbac_entity_roles ADD CONSTRAINT rbac_entity_roles_role_id_fkey
  FOREIGN KEY (role_id) REFERENCES rbac_roles(id) ON DELETE RESTRICT;

-- 4. Add missing roles: strategy, finance, content, general
INSERT INTO rbac_roles (id, name, parent_role_id, description) VALUES
  ('a0000000-0000-0000-0000-000000000006', 'strategy_agent', 'a0000000-0000-0000-0000-000000000001', 'Strategy and planning agent'),
  ('a0000000-0000-0000-0000-000000000007', 'finance_agent', 'a0000000-0000-0000-0000-000000000001', 'Finance and accounting agent'),
  ('a0000000-0000-0000-0000-000000000008', 'content_agent', 'a0000000-0000-0000-0000-000000000001', 'Content creation agent'),
  ('a0000000-0000-0000-0000-000000000009', 'general_agent', 'a0000000-0000-0000-0000-000000000001', 'General orchestrator agent')
ON CONFLICT (name) DO NOTHING;

-- 5. Fix permission coverage gaps

-- research_agent needs forest.read + plane.read_issue (ELLIE-1268: permission-guard alignment)
INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT 'a0000000-0000-0000-0000-000000000004', id FROM rbac_permissions
WHERE (resource = 'forest' AND action = 'read')
   OR (resource = 'plane' AND action = 'read_issue')
ON CONFLICT DO NOTHING;

-- critic_agent needs forest.read
INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT 'a0000000-0000-0000-0000-000000000003', id FROM rbac_permissions
WHERE resource = 'forest' AND action = 'read'
ON CONFLICT DO NOTHING;

-- strategy_agent: plane.read_issue, forest.read, forest.write, memory.read, memory.write
INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT 'a0000000-0000-0000-0000-000000000006', id FROM rbac_permissions
WHERE (resource = 'plane' AND action = 'read_issue')
   OR (resource = 'forest' AND action IN ('read', 'write'))
   OR (resource = 'memory' AND action IN ('read', 'write'))
ON CONFLICT DO NOTHING;

-- finance_agent: plane.read_issue, tools.use_mcp, forest.read, memory.read
INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT 'a0000000-0000-0000-0000-000000000007', id FROM rbac_permissions
WHERE (resource = 'plane' AND action = 'read_issue')
   OR (resource = 'tools' AND action = 'use_mcp')
   OR (resource = 'forest' AND action = 'read')
   OR (resource = 'memory' AND action = 'read')
ON CONFLICT DO NOTHING;

-- content_agent: forest.write, forest.read, messages.send, memory.read, memory.write, plane.read_issue
INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT 'a0000000-0000-0000-0000-000000000008', id FROM rbac_permissions
WHERE (resource = 'forest' AND action IN ('read', 'write'))
   OR (resource = 'messages' AND action = 'send')
   OR (resource = 'memory' AND action IN ('read', 'write'))
   OR (resource = 'plane' AND action = 'read_issue')
ON CONFLICT DO NOTHING;

-- general_agent: messages.send, messages.read, memory.read, forest.read, plane.read_issue
INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT 'a0000000-0000-0000-0000-000000000009', id FROM rbac_permissions
WHERE (resource = 'messages' AND action IN ('send', 'read'))
   OR (resource = 'memory' AND action = 'read')
   OR (resource = 'forest' AND action = 'read')
   OR (resource = 'plane' AND action = 'read_issue')
ON CONFLICT DO NOTHING;
