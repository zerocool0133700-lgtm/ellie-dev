-- Person Trees & Groves Migration
-- Each person gets a living tree in the forest (type: 'person').
-- Groups become groves — branches can belong to a group for shared context.

-- ── 1a. Add 'person' to tree_type enum ─────────────────────
DO $$ BEGIN
  ALTER TYPE tree_type ADD VALUE IF NOT EXISTS 'person';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 1b. People get a tree link ─────────────────────────────
ALTER TABLE people ADD COLUMN IF NOT EXISTS tree_id UUID REFERENCES trees(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_people_tree_id ON people(tree_id) WHERE tree_id IS NOT NULL;

-- ── 1c. Branches can belong to a grove (group) ────────────
ALTER TABLE branches ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_branches_group_id ON branches(group_id) WHERE group_id IS NOT NULL;
