-- ELLIE-791: Core permission set and role-permission mappings
-- Deterministic UUIDs for stable references. Depends on 20260316_rbac_roles.sql.

-- ═══════════════════════════════════════════════════════════
-- PERMISSIONS
-- ═══════════════════════════════════════════════════════════

-- plane
INSERT INTO rbac_permissions (id, resource, action, scope, description) VALUES
  ('b0000000-0000-0000-0001-000000000001', 'plane', 'create_issue', NULL, 'Create Plane issues'),
  ('b0000000-0000-0000-0001-000000000002', 'plane', 'update_issue', NULL, 'Update Plane issues'),
  ('b0000000-0000-0000-0001-000000000003', 'plane', 'read_issue', NULL, 'Read Plane issues'),
  ('b0000000-0000-0000-0001-000000000004', 'plane', 'comment', NULL, 'Comment on Plane issues'),
  ('b0000000-0000-0000-0001-000000000005', 'plane', 'manage_cycles', NULL, 'Manage Plane cycles and modules')
ON CONFLICT (resource, action, scope) DO NOTHING;

-- forest
INSERT INTO rbac_permissions (id, resource, action, scope, description) VALUES
  ('b0000000-0000-0000-0002-000000000001', 'forest', 'read', NULL, 'Read Forest trees and branches'),
  ('b0000000-0000-0000-0002-000000000002', 'forest', 'write', NULL, 'Write to Forest trees and branches'),
  ('b0000000-0000-0000-0002-000000000003', 'forest', 'delete', NULL, 'Delete Forest entries'),
  ('b0000000-0000-0000-0002-000000000004', 'forest', 'manage_scopes', NULL, 'Manage Forest knowledge scopes')
ON CONFLICT (resource, action, scope) DO NOTHING;

-- git
INSERT INTO rbac_permissions (id, resource, action, scope, description) VALUES
  ('b0000000-0000-0000-0003-000000000001', 'git', 'commit', NULL, 'Create git commits'),
  ('b0000000-0000-0000-0003-000000000002', 'git', 'push', NULL, 'Push to remote repositories'),
  ('b0000000-0000-0000-0003-000000000003', 'git', 'create_branch', NULL, 'Create git branches'),
  ('b0000000-0000-0000-0003-000000000004', 'git', 'create_pr', NULL, 'Create pull requests')
ON CONFLICT (resource, action, scope) DO NOTHING;

-- messages
INSERT INTO rbac_permissions (id, resource, action, scope, description) VALUES
  ('b0000000-0000-0000-0004-000000000001', 'messages', 'send', NULL, 'Send messages to channels'),
  ('b0000000-0000-0000-0004-000000000002', 'messages', 'read', NULL, 'Read message history'),
  ('b0000000-0000-0000-0004-000000000003', 'messages', 'delete', NULL, 'Delete messages')
ON CONFLICT (resource, action, scope) DO NOTHING;

-- agents
INSERT INTO rbac_permissions (id, resource, action, scope, description) VALUES
  ('b0000000-0000-0000-0005-000000000001', 'agents', 'dispatch', NULL, 'Dispatch work to agents'),
  ('b0000000-0000-0000-0005-000000000002', 'agents', 'monitor', NULL, 'Monitor agent status and health'),
  ('b0000000-0000-0000-0005-000000000003', 'agents', 'configure', NULL, 'Configure agent settings'),
  ('b0000000-0000-0000-0005-000000000004', 'agents', 'terminate', NULL, 'Terminate agent sessions')
ON CONFLICT (resource, action, scope) DO NOTHING;

-- tools
INSERT INTO rbac_permissions (id, resource, action, scope, description) VALUES
  ('b0000000-0000-0000-0006-000000000001', 'tools', 'use_bash', NULL, 'Execute bash commands'),
  ('b0000000-0000-0000-0006-000000000002', 'tools', 'use_edit', NULL, 'Edit files on disk'),
  ('b0000000-0000-0000-0006-000000000003', 'tools', 'use_web', NULL, 'Access web resources'),
  ('b0000000-0000-0000-0006-000000000004', 'tools', 'use_mcp', NULL, 'Use MCP server tools')
ON CONFLICT (resource, action, scope) DO NOTHING;

-- system
INSERT INTO rbac_permissions (id, resource, action, scope, description) VALUES
  ('b0000000-0000-0000-0007-000000000001', 'system', 'restart_service', NULL, 'Restart system services'),
  ('b0000000-0000-0000-0007-000000000002', 'system', 'manage_config', NULL, 'Manage system configuration'),
  ('b0000000-0000-0000-0007-000000000003', 'system', 'manage_secrets', NULL, 'Manage secrets and credentials')
ON CONFLICT (resource, action, scope) DO NOTHING;

-- memory
INSERT INTO rbac_permissions (id, resource, action, scope, description) VALUES
  ('b0000000-0000-0000-0008-000000000001', 'memory', 'read', NULL, 'Read conversation memory'),
  ('b0000000-0000-0000-0008-000000000002', 'memory', 'write', NULL, 'Write to conversation memory'),
  ('b0000000-0000-0000-0008-000000000003', 'memory', 'delete', NULL, 'Delete memory entries')
ON CONFLICT (resource, action, scope) DO NOTHING;

-- ═══════════════════════════════════════════════════════════
-- ROLE-PERMISSION MAPPINGS
-- ═══════════════════════════════════════════════════════════

-- Role IDs (from 20260316_rbac_roles.sql):
-- agent_base:      a0000000-0000-0000-0000-000000000001
-- dev_agent:       a0000000-0000-0000-0000-000000000002
-- critic_agent:    a0000000-0000-0000-0000-000000000003
-- research_agent:  a0000000-0000-0000-0000-000000000004
-- super_user:      a0000000-0000-0000-0000-000000000010
-- super_agent:     a0000000-0000-0000-0000-000000000011

-- agent_base: messages.send, messages.read, memory.read, memory.write, forest.read
INSERT INTO rbac_role_permissions (role_id, permission_id) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0004-000000000001'),
  ('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0004-000000000002'),
  ('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0008-000000000001'),
  ('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0008-000000000002'),
  ('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0002-000000000001')
ON CONFLICT DO NOTHING;

-- dev_agent: plane.*, git.*, forest.write, tools.use_bash, tools.use_edit, tools.use_mcp
INSERT INTO rbac_role_permissions (role_id, permission_id) VALUES
  ('a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0001-000000000001'),
  ('a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0001-000000000002'),
  ('a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0001-000000000003'),
  ('a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0001-000000000004'),
  ('a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0001-000000000005'),
  ('a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0003-000000000001'),
  ('a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0003-000000000002'),
  ('a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0003-000000000003'),
  ('a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0003-000000000004'),
  ('a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0002-000000000002'),
  ('a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0006-000000000001'),
  ('a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0006-000000000002'),
  ('a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0006-000000000004')
ON CONFLICT DO NOTHING;

-- critic_agent: plane.read_issue, plane.comment, forest.read, tools.use_web
INSERT INTO rbac_role_permissions (role_id, permission_id) VALUES
  ('a0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0001-000000000003'),
  ('a0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0001-000000000004'),
  ('a0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0006-000000000003')
ON CONFLICT DO NOTHING;

-- research_agent: forest.read, tools.use_web, tools.use_mcp, plane.read_issue
INSERT INTO rbac_role_permissions (role_id, permission_id) VALUES
  ('a0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0006-000000000003'),
  ('a0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0006-000000000004'),
  ('a0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0001-000000000003')
ON CONFLICT DO NOTHING;

-- super_agent: ALL permissions (Ellie gets everything)
INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT 'a0000000-0000-0000-0000-000000000011', id FROM rbac_permissions
ON CONFLICT DO NOTHING;

-- super_user: ALL permissions (Dave gets everything)
INSERT INTO rbac_role_permissions (role_id, permission_id)
SELECT 'a0000000-0000-0000-0000-000000000010', id FROM rbac_permissions
ON CONFLICT DO NOTHING;
