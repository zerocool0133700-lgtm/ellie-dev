-- ELLIE-795: Register James as dev agent entity
-- Depends on 20260316_rbac_roles.sql and 20260316_rbac_entities.sql

-- James — dev agent, first specialized agent
INSERT INTO rbac_entities (id, entity_type, name, archetype, metadata)
VALUES (
  'e0000000-0000-0000-0000-000000000003',
  'agent',
  'James',
  'james',
  '{"capabilities": ["code", "git", "plane", "forest", "config", "service_management"], "bridge_key": "bk_04fc33cf9a62aae63e0e07f4c5b5be9a6e6375bb60499b6af16b6c5dc5441948"}'::jsonb
) ON CONFLICT (id) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  name = EXCLUDED.name,
  archetype = EXCLUDED.archetype,
  metadata = EXCLUDED.metadata;

-- James → dev_agent role (granted by Ellie)
INSERT INTO rbac_entity_roles (entity_id, role_id, granted_by)
VALUES (
  'e0000000-0000-0000-0000-000000000003',
  'a0000000-0000-0000-0000-000000000002',
  'e0000000-0000-0000-0000-000000000002'
) ON CONFLICT (entity_id, role_id) DO NOTHING;
