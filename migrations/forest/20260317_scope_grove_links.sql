-- ELLIE-818: Link existing project scopes to groves
--
-- Create project groves for the main ellie projects and link
-- the existing knowledge scopes (2/1, 2/2, etc.) to group_ids.

-- ── 1. Create project groves ────────────────────────────────────

INSERT INTO groups (id, name, description, metadata)
VALUES
  ('a1000000-0000-0000-0000-000000000010', 'ellie-dev-grove',
   'Shared workspace for ellie-dev project knowledge',
   '{"type": "project-grove", "project": "ellie-dev", "scope_path": "2/1"}'::jsonb),
  ('a1000000-0000-0000-0000-000000000011', 'ellie-forest-grove',
   'Shared workspace for ellie-forest project knowledge',
   '{"type": "project-grove", "project": "ellie-forest", "scope_path": "2/2"}'::jsonb),
  ('a1000000-0000-0000-0000-000000000012', 'ellie-home-grove',
   'Shared workspace for ellie-home project knowledge',
   '{"type": "project-grove", "project": "ellie-home", "scope_path": "2/3"}'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- ── 2. Link existing knowledge scopes to their groves ───────────

UPDATE knowledge_scopes SET group_id = 'a1000000-0000-0000-0000-000000000010'
WHERE path = '2/1' AND group_id IS NULL;

UPDATE knowledge_scopes SET group_id = 'a1000000-0000-0000-0000-000000000011'
WHERE path = '2/2' AND group_id IS NULL;

UPDATE knowledge_scopes SET group_id = 'a1000000-0000-0000-0000-000000000012'
WHERE path = '2/3' AND group_id IS NULL;

-- ── 3. Add agents as members of project groves ──────────────────

-- James (dev) gets write access to dev + forest project groves
INSERT INTO group_memberships (group_id, person_id, role, access_level)
VALUES
  ('a1000000-0000-0000-0000-000000000010', 'e0000000-0000-0000-0000-000000000003', 'contributor', 'write'),
  ('a1000000-0000-0000-0000-000000000011', 'e0000000-0000-0000-0000-000000000003', 'contributor', 'write')
ON CONFLICT (group_id, person_id) DO NOTHING;

-- Brian (critic) gets read access to ellie-dev
INSERT INTO group_memberships (group_id, person_id, role, access_level)
VALUES
  ('a1000000-0000-0000-0000-000000000010', 'e0000000-0000-0000-0000-000000000004', 'reviewer', 'read')
ON CONFLICT (group_id, person_id) DO NOTHING;
