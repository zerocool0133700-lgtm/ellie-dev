-- ELLIE-792: Seed Dave and Ellie as initial entities
-- Depends on 20260316_rbac_roles.sql for role IDs.

-- Dave — super_user, top of chain
INSERT INTO rbac_entities (id, entity_type, name, archetype, metadata)
VALUES (
  'e0000000-0000-0000-0000-000000000001',
  'user',
  'Dave',
  NULL,
  '{"timezone": "America/Chicago", "preferences": {"dyslexia_mode": true, "audio_first": true}}'::jsonb
) ON CONFLICT (id) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  name = EXCLUDED.name,
  archetype = EXCLUDED.archetype,
  metadata = EXCLUDED.metadata;

-- Ellie — super_agent, full system autonomy with governance
INSERT INTO rbac_entities (id, entity_type, name, archetype, metadata)
VALUES (
  'e0000000-0000-0000-0000-000000000002',
  'super_agent',
  'Ellie',
  'ellie',
  '{"capabilities": ["orchestrate", "dispatch", "plan", "execute"], "governance": {"speak_for_dave": false, "commit_dave": false, "partnership": true}}'::jsonb
) ON CONFLICT (id) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  name = EXCLUDED.name,
  archetype = EXCLUDED.archetype,
  metadata = EXCLUDED.metadata;

-- Role assignments

-- Dave → super_user
INSERT INTO rbac_entity_roles (entity_id, role_id, granted_by)
VALUES (
  'e0000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000010',
  NULL
) ON CONFLICT (entity_id, role_id) DO NOTHING;

-- Ellie → super_agent
INSERT INTO rbac_entity_roles (entity_id, role_id, granted_by)
VALUES (
  'e0000000-0000-0000-0000-000000000002',
  'a0000000-0000-0000-0000-000000000011',
  'e0000000-0000-0000-0000-000000000001'
) ON CONFLICT (entity_id, role_id) DO NOTHING;
