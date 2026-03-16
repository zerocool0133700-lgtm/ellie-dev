-- ELLIE-790: Initial role hierarchy seed
-- Roles are inserted with deterministic UUIDs for stable FK references.

-- agent_base — shared baseline for all agent roles
INSERT INTO rbac_roles (id, name, parent_role_id, description)
VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'agent_base',
  NULL,
  'Shared baseline permissions for all agent roles'
) ON CONFLICT (name) DO NOTHING;

-- dev_agent — code, git, plane, forest access
INSERT INTO rbac_roles (id, name, parent_role_id, description)
VALUES (
  'a0000000-0000-0000-0000-000000000002',
  'dev_agent',
  'a0000000-0000-0000-0000-000000000001',
  'Development agent: code, git, Plane, Forest access'
) ON CONFLICT (name) DO NOTHING;

-- critic_agent — review, feedback, quality checks
INSERT INTO rbac_roles (id, name, parent_role_id, description)
VALUES (
  'a0000000-0000-0000-0000-000000000003',
  'critic_agent',
  'a0000000-0000-0000-0000-000000000001',
  'Critic agent: review, feedback, quality checks'
) ON CONFLICT (name) DO NOTHING;

-- research_agent — search, analyze, report
INSERT INTO rbac_roles (id, name, parent_role_id, description)
VALUES (
  'a0000000-0000-0000-0000-000000000004',
  'research_agent',
  'a0000000-0000-0000-0000-000000000001',
  'Research agent: search, analyze, report'
) ON CONFLICT (name) DO NOTHING;

-- super_user — top of chain (Dave), all permissions
INSERT INTO rbac_roles (id, name, parent_role_id, description)
VALUES (
  'a0000000-0000-0000-0000-000000000010',
  'super_user',
  NULL,
  'Top-level user role with all permissions (Dave)'
) ON CONFLICT (name) DO NOTHING;

-- super_agent — Ellie, inherits from agent_base, full system autonomy
INSERT INTO rbac_roles (id, name, parent_role_id, description)
VALUES (
  'a0000000-0000-0000-0000-000000000011',
  'super_agent',
  'a0000000-0000-0000-0000-000000000001',
  'Super agent (Ellie): full system autonomy with governance, inherits all agent_base permissions'
) ON CONFLICT (name) DO NOTHING;
