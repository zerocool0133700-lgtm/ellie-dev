-- Forest-Calendar Alignment Migration
-- Bridges people, groups, and calendar_events into the forest entity/tree model.
--
-- People & groups become forest entities (type: 'person' / 'group').
-- Calendar events can optionally spawn forest trees (type: 'calendar_event').

-- ── 1. Extend forest enums ──────────────────────────────────

-- Add new entity types (idempotent)
DO $$ BEGIN
  ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'person';
  ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'group';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add new tree type (idempotent)
DO $$ BEGIN
  ALTER TYPE tree_type ADD VALUE IF NOT EXISTS 'calendar_event';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 2. Bridge columns ───────────────────────────────────────

-- People → forest entity link
ALTER TABLE people
  ADD COLUMN IF NOT EXISTS entity_id UUID REFERENCES entities(id) ON DELETE SET NULL;

-- Groups → forest entity link
ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS entity_id UUID REFERENCES entities(id) ON DELETE SET NULL;

-- Calendar events → optional forest tree + owner entity
ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS tree_id UUID REFERENCES trees(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS owner_entity_id UUID REFERENCES entities(id) ON DELETE SET NULL;

-- ── 3. Indexes ──────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_people_entity_id ON people(entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_groups_entity_id ON groups(entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calendar_events_tree_id ON calendar_events(tree_id) WHERE tree_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calendar_events_owner_entity ON calendar_events(owner_entity_id) WHERE owner_entity_id IS NOT NULL;

-- ── 4. Auto-create forest entities for existing people ──────

INSERT INTO entities (id, name, display_name, type, contribution, capabilities, config, active)
SELECT
  gen_random_uuid(),
  lower(replace(p.name, ' ', '-')),
  p.name,
  'person',
  'many_trees',
  '[]'::jsonb,
  jsonb_build_object('person_id', p.id, 'relationship_type', p.relationship_type),
  true
FROM people p
WHERE p.entity_id IS NULL
ON CONFLICT DO NOTHING;

-- Link people to their new entities
UPDATE people p
SET entity_id = e.id
FROM entities e
WHERE e.type = 'person'
  AND (e.config->>'person_id')::uuid = p.id
  AND p.entity_id IS NULL;

-- ── 5. Auto-create forest entities for existing groups ──────

INSERT INTO entities (id, name, display_name, type, contribution, capabilities, config, active)
SELECT
  gen_random_uuid(),
  lower(replace(g.name, ' ', '-')),
  g.name,
  'group',
  'many_trees',
  '[]'::jsonb,
  jsonb_build_object('group_id', g.id),
  true
FROM groups g
WHERE g.entity_id IS NULL
ON CONFLICT DO NOTHING;

-- Link groups to their new entities
UPDATE groups g
SET entity_id = e.id
FROM entities e
WHERE e.type = 'group'
  AND (e.config->>'group_id')::uuid = g.id
  AND g.entity_id IS NULL;
