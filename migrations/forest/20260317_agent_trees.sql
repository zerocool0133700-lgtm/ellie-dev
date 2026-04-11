-- ELLIE-818: Create agent trees in the Forest
-- Each agent (James=dev, Brian=critic) gets:
--   1. A Forest entity record
--   2. An rbac_entity record
--   3. A people record linked to the Forest entity
--   4. A person tree in the Forest
--   5. Role assignments (rbac)
--
-- Also ensures Dave & Ellie rbac_entities + roles exist.

-- ── 1. Apply RBAC role seeds (idempotent) ───────────────────────

INSERT INTO rbac_roles (id, name, parent_role_id, description)
VALUES
  ('a0000000-0000-0000-0000-000000000001', 'agent_base', NULL, 'Shared baseline permissions for all agent roles'),
  ('a0000000-0000-0000-0000-000000000002', 'dev_agent', 'a0000000-0000-0000-0000-000000000001', 'Development agent: code, git, Plane, Forest access'),
  ('a0000000-0000-0000-0000-000000000003', 'critic_agent', 'a0000000-0000-0000-0000-000000000001', 'Critic agent: review, feedback, quality checks'),
  ('a0000000-0000-0000-0000-000000000004', 'research_agent', 'a0000000-0000-0000-0000-000000000001', 'Research agent: search, analyze, report'),
  ('a0000000-0000-0000-0000-000000000010', 'super_user', NULL, 'Top-level user role with all permissions (Dave)'),
  ('a0000000-0000-0000-0000-000000000011', 'super_agent', 'a0000000-0000-0000-0000-000000000001', 'Super agent (Ellie): full system autonomy')
ON CONFLICT (name) DO NOTHING;

-- ── 2. Create Forest entities for agents ────────────────────────

INSERT INTO entities (id, name, display_name, type, contribution, capabilities, config)
VALUES (
  'e0000000-0000-0000-0000-000000000003',
  'james', 'James', 'agent', 'many_trees',
  '["code", "test", "debug", "deploy"]'::jsonb,
  '{"archetype": "dev", "species": "ant"}'::jsonb
) ON CONFLICT (name) DO NOTHING;

INSERT INTO entities (id, name, display_name, type, contribution, capabilities, config)
VALUES (
  'e0000000-0000-0000-0000-000000000004',
  'brian', 'Brian', 'agent', 'many_trees',
  '["review", "audit", "assess"]'::jsonb,
  '{"archetype": "critic", "species": "owl"}'::jsonb
) ON CONFLICT (name) DO NOTHING;

-- ── 3. Create RBAC entities ─────────────────────────────────────

INSERT INTO rbac_entities (id, entity_type, name, archetype, metadata)
VALUES
  ('e0000000-0000-0000-0000-000000000001', 'user', 'Dave', NULL,
   '{"timezone": "America/Chicago", "preferences": {"dyslexia_mode": true}}'::jsonb),
  ('e0000000-0000-0000-0000-000000000002', 'super_agent', 'Ellie', 'orchestrator',
   '{"capabilities": ["orchestrate", "dispatch", "plan", "execute"]}'::jsonb),
  ('e0000000-0000-0000-0000-000000000003', 'agent', 'James', 'dev',
   '{"species": "ant", "forest_entity_id": "e0000000-0000-0000-0000-000000000003"}'::jsonb),
  ('e0000000-0000-0000-0000-000000000004', 'agent', 'Brian', 'critic',
   '{"species": "owl", "forest_entity_id": "e0000000-0000-0000-0000-000000000004"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- ── 4. Create people records ────────────────────────────────────

INSERT INTO people (id, name, relationship_type, notes, entity_id)
VALUES (
  'e0000000-0000-0000-0000-000000000003',
  'James', 'agent', 'Dev agent — ant archetype, depth-first focus',
  'e0000000-0000-0000-0000-000000000003'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO people (id, name, relationship_type, notes, entity_id)
VALUES (
  'e0000000-0000-0000-0000-000000000004',
  'Brian', 'agent', 'Critic agent — owl archetype, review and audit',
  'e0000000-0000-0000-0000-000000000004'
) ON CONFLICT (id) DO NOTHING;

-- ── 5. Create person trees ──────────────────────────────────────

INSERT INTO trees (id, type, state, title, description, metadata)
VALUES (
  'f0000000-0000-0000-0000-000000000003',
  'person', 'seedling', 'James',
  'Personal knowledge tree for James (dev agent)',
  '{"entity_id": "e0000000-0000-0000-0000-000000000003", "archetype": "dev"}'::jsonb
) ON CONFLICT (id) DO NOTHING;

INSERT INTO trees (id, type, state, title, description, metadata)
VALUES (
  'f0000000-0000-0000-0000-000000000004',
  'person', 'seedling', 'Brian',
  'Personal knowledge tree for Brian (critic agent)',
  '{"entity_id": "e0000000-0000-0000-0000-000000000004", "archetype": "critic"}'::jsonb
) ON CONFLICT (id) DO NOTHING;

-- ── 6. Link people to trees ─────────────────────────────────────

UPDATE people SET tree_id = 'f0000000-0000-0000-0000-000000000003'
WHERE id = 'e0000000-0000-0000-0000-000000000003' AND tree_id IS NULL;

UPDATE people SET tree_id = 'f0000000-0000-0000-0000-000000000004'
WHERE id = 'e0000000-0000-0000-0000-000000000004' AND tree_id IS NULL;

-- ── 7. Assign RBAC roles ────────────────────────────────────────

INSERT INTO rbac_entity_roles (entity_id, role_id, granted_by)
VALUES
  ('e0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000010', NULL),
  ('e0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000011', 'e0000000-0000-0000-0000-000000000001'),
  ('e0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001'),
  ('e0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000001')
ON CONFLICT (entity_id, role_id) DO NOTHING;
