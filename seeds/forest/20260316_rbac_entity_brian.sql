-- ELLIE-796: Register Brian as critic agent entity
-- Depends on 20260316_rbac_roles.sql and 20260316_rbac_entities.sql

-- Brian — critic agent
INSERT INTO rbac_entities (id, entity_type, name, archetype, metadata)
VALUES (
  'e0000000-0000-0000-0000-000000000004',
  'agent',
  'Brian',
  'brian',
  '{"capabilities": ["review", "feedback", "quality_checks", "code_review", "ui_review"], "domains": ["ellie-dev", "ellie-home"], "domain_note": "critic scope may be limited to specific projects via permission scoping"}'::jsonb
) ON CONFLICT (id) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  name = EXCLUDED.name,
  archetype = EXCLUDED.archetype,
  metadata = EXCLUDED.metadata;

-- Brian → critic_agent role (granted by Ellie)
INSERT INTO rbac_entity_roles (entity_id, role_id, granted_by)
VALUES (
  'e0000000-0000-0000-0000-000000000004',
  'a0000000-0000-0000-0000-000000000003',
  'e0000000-0000-0000-0000-000000000002'
) ON CONFLICT (entity_id, role_id) DO NOTHING;
