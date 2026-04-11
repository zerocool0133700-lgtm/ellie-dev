-- Amy (Content agent) Forest setup
-- Parallel to James and Brian setup from 20260317_agent_trees.sql

-- ── 1. Create Forest entity for Amy ──────────────────────────────

INSERT INTO entities (id, name, display_name, type, contribution, capabilities, config)
VALUES (
  'e0000000-0000-0000-0000-000000000005',
  'amy', 'Amy', 'agent', 'many_trees',
  '["writing", "editing", "documentation", "content_creation"]'::jsonb,
  '{"archetype": "content", "species": "ant"}'::jsonb
) ON CONFLICT (name) DO NOTHING;

-- ── 2. Create RBAC entity ────────────────────────────────────────

-- First ensure content_agent role exists
INSERT INTO rbac_roles (id, name, parent_role_id, description)
VALUES (
  'a0000000-0000-0000-0000-000000000005',
  'content_agent',
  'a0000000-0000-0000-0000-000000000001',  -- parent: agent_base
  'Content agent: writing, docs, social media'
) ON CONFLICT (name) DO NOTHING;

INSERT INTO rbac_entities (id, entity_type, name, archetype, metadata)
VALUES (
  'e0000000-0000-0000-0000-000000000005',
  'agent',
  'Amy',
  'amy',
  '{"species": "ant", "forest_entity_id": "e0000000-0000-0000-0000-000000000005"}'::jsonb
) ON CONFLICT (id) DO NOTHING;

-- ── 3. Create people record ──────────────────────────────────────

INSERT INTO people (id, name, relationship_type, notes, entity_id)
VALUES (
  'e0000000-0000-0000-0000-000000000005',
  'Amy',
  'agent',
  'Content agent — ant archetype, writing and documentation',
  'e0000000-0000-0000-0000-000000000005'
) ON CONFLICT (id) DO NOTHING;

-- ── 4. Create person tree ────────────────────────────────────────

INSERT INTO trees (id, type, state, title, description, metadata)
VALUES (
  'f0000000-0000-0000-0000-000000000005',
  'person',
  'seedling',
  'Amy',
  'Personal knowledge tree for Amy (content agent)',
  '{"entity_id": "e0000000-0000-0000-0000-000000000005", "archetype": "content"}'::jsonb
) ON CONFLICT (id) DO NOTHING;

-- ── 5. Link person to tree ───────────────────────────────────────

UPDATE people SET tree_id = 'f0000000-0000-0000-0000-000000000005'
WHERE id = 'e0000000-0000-0000-0000-000000000005' AND tree_id IS NULL;

-- ── 6. Assign RBAC role ──────────────────────────────────────────

INSERT INTO rbac_entity_roles (entity_id, role_id, granted_by)
VALUES (
  'e0000000-0000-0000-0000-000000000005',  -- Amy
  'a0000000-0000-0000-0000-000000000005',  -- content_agent role
  'e0000000-0000-0000-0000-000000000001'   -- granted by Dave
) ON CONFLICT (entity_id, role_id) DO NOTHING;

-- ── 7. Add Amy to project groves ─────────────────────────────────

-- Amy gets write access to ellie-home grove (UI/content work)
INSERT INTO group_memberships (group_id, person_id, role, access_level)
VALUES (
  'a1000000-0000-0000-0000-000000000012',  -- ellie-home-grove
  'e0000000-0000-0000-0000-000000000005',  -- Amy
  'contributor',
  'write'
) ON CONFLICT (group_id, person_id) DO NOTHING;

-- Amy gets read access to ellie-dev grove (for reference/context)
INSERT INTO group_memberships (group_id, person_id, role, access_level)
VALUES (
  'a1000000-0000-0000-0000-000000000010',  -- ellie-dev-grove
  'e0000000-0000-0000-0000-000000000005',  -- Amy
  'observer',
  'read'
) ON CONFLICT (group_id, person_id) DO NOTHING;
