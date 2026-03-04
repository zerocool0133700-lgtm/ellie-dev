-- ELLIE-52: Chain-scoped groups/people model
-- Run against Supabase SQL editor AFTER 20260219_groups_people.sql

-- ============================================================
-- SEED: Dave (chain owner) and Goda
-- ============================================================

INSERT INTO people (name, relationship_type, notes) VALUES
  ('Dave', 'self', 'Chain owner')
ON CONFLICT DO NOTHING;

INSERT INTO people (name, relationship_type, notes) VALUES
  ('Goda', 'partner', 'Dave''s partner')
ON CONFLICT DO NOTHING;

-- Add Goda to Family group
INSERT INTO group_memberships (group_id, person_id)
SELECT g.id, p.id FROM groups g, people p
WHERE g.name = 'Family' AND p.name = 'Goda'
ON CONFLICT (group_id, person_id) DO NOTHING;

-- Add Dave to Family group as admin
INSERT INTO group_memberships (group_id, person_id, role)
SELECT g.id, p.id, 'admin' FROM groups g, people p
WHERE g.name = 'Family' AND p.name = 'Dave' AND p.relationship_type = 'self'
ON CONFLICT (group_id, person_id) DO NOTHING;

-- ============================================================
-- CHAIN SCOPING: Add owner_id to groups
-- ============================================================

ALTER TABLE groups ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES people(id);

-- Backfill: Dave owns all existing groups
UPDATE groups SET owner_id = (
  SELECT id FROM people WHERE name = 'Dave' AND relationship_type = 'self' LIMIT 1
) WHERE owner_id IS NULL;

-- Make NOT NULL after backfill
ALTER TABLE groups ALTER COLUMN owner_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_groups_owner_id ON groups(owner_id);

-- ============================================================
-- CHAIN SCOPING: Add owner_id to group_memberships
-- ============================================================

ALTER TABLE group_memberships ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES people(id);

-- Backfill: inherit owner_id from parent group
UPDATE group_memberships gm SET owner_id = g.owner_id
FROM groups g WHERE gm.group_id = g.id AND gm.owner_id IS NULL;

ALTER TABLE group_memberships ALTER COLUMN owner_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_group_memberships_owner_id ON group_memberships(owner_id);
