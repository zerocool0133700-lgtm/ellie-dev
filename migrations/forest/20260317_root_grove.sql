-- ELLIE-818: Create root organizational grove and agent knowledge scopes
--
-- Structure:
--   3           = Agents (top-level domain for agent knowledge)
--   3/james     = James personal scope (linked to his tree)
--   3/brian     = Brian personal scope (linked to his tree)
--   3/org       = Root grove (ellie-org) — all agents are members

-- ── 1. Create top-level "Agents" scope ──────────────────────────

INSERT INTO knowledge_scopes (id, path, name, level, parent_id, description)
VALUES (
  'b0000000-0000-0000-0000-000000000001',
  '3', 'Agents', 'domain', NULL,
  'Agent personal knowledge and shared workspaces'
) ON CONFLICT (path) DO NOTHING;

-- ── 2. Create personal agent scopes ─────────────────────────────

INSERT INTO knowledge_scopes (id, path, name, level, parent_id, tree_id, description)
VALUES (
  'b0000000-0000-0000-0000-000000000003',
  '3/james', 'James', 'tree',
  'b0000000-0000-0000-0000-000000000001',
  'f0000000-0000-0000-0000-000000000003',
  'Personal knowledge scope for James (dev agent)'
) ON CONFLICT (path) DO NOTHING;

INSERT INTO knowledge_scopes (id, path, name, level, parent_id, tree_id, description)
VALUES (
  'b0000000-0000-0000-0000-000000000004',
  '3/brian', 'Brian', 'tree',
  'b0000000-0000-0000-0000-000000000001',
  'f0000000-0000-0000-0000-000000000004',
  'Personal knowledge scope for Brian (critic agent)'
) ON CONFLICT (path) DO NOTHING;

-- ── 3. Create root organizational grove ─────────────────────────

INSERT INTO groups (id, name, description, icon, metadata, entity_id)
VALUES (
  'a1000000-0000-0000-0000-000000000001',
  'ellie-org',
  'Root organizational grove — all agents and users',
  NULL,
  '{"type": "grove", "scope_path": "3/org"}'::jsonb,
  (SELECT id FROM entities WHERE name = 'relay_bot' LIMIT 1)
) ON CONFLICT (name) DO NOTHING;

-- Create scope for root grove
INSERT INTO knowledge_scopes (id, path, name, level, parent_id, group_id, description)
VALUES (
  'b0000000-0000-0000-0000-000000000010',
  '3/org', 'ellie-org', 'grove',
  'b0000000-0000-0000-0000-000000000001',
  'a1000000-0000-0000-0000-000000000001',
  'Root organizational grove — shared knowledge for all agents'
) ON CONFLICT (path) DO NOTHING;

-- ── 4. Add agents as grove members ──────────────────────────────

-- James (dev) — write access
INSERT INTO group_memberships (group_id, person_id, role, access_level)
VALUES (
  'a1000000-0000-0000-0000-000000000001',
  'e0000000-0000-0000-0000-000000000003',
  'member', 'write'
) ON CONFLICT (group_id, person_id) DO NOTHING;

-- Brian (critic) — read access
INSERT INTO group_memberships (group_id, person_id, role, access_level)
VALUES (
  'a1000000-0000-0000-0000-000000000001',
  'e0000000-0000-0000-0000-000000000004',
  'member', 'read'
) ON CONFLICT (group_id, person_id) DO NOTHING;
