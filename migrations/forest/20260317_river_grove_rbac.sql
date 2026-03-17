-- ELLIE-823 + ELLIE-825: River and Grove RBAC resources

-- River resource: owner-only with admin override
INSERT INTO rbac_permissions (resource, action, scope, description) VALUES
  ('river', 'read', NULL, 'Read own River workspace'),
  ('river', 'write', NULL, 'Write to own River workspace'),
  ('river', 'admin_read', NULL, 'Admin override: read any River workspace'),
  ('river', 'publish', NULL, 'Publish from River to Grove')
ON CONFLICT (resource, action, scope) DO NOTHING;

-- Grant river.read + river.write + river.publish to agent_base (all agents)
INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT 'a0000000-0000-0000-0000-000000000001', id FROM rbac_permissions
WHERE resource = 'river' AND action IN ('read', 'write', 'publish')
ON CONFLICT DO NOTHING;

-- Grant river.admin_read to super_user and super_agent only
INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT 'a0000000-0000-0000-0000-000000000010', id FROM rbac_permissions
WHERE resource = 'river' AND action = 'admin_read'
ON CONFLICT DO NOTHING;

INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT 'a0000000-0000-0000-0000-000000000011', id FROM rbac_permissions
WHERE resource = 'river' AND action = 'admin_read'
ON CONFLICT DO NOTHING;

-- ELLIE-829: Formation grove table (if not exists)
CREATE TABLE IF NOT EXISTS formation_groves (
  formation_name TEXT NOT NULL,
  session_id TEXT NOT NULL,
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  scope_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (formation_name, session_id)
);
