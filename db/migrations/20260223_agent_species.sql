-- Agent Species Migration
-- Agents have a species that defines their behavior pattern:
--   ant      — focused branch worker, stays on one branch
--   bee      — cross-pollinator, moves between trees/groves
--   squirrel — gatherer/retriever, roams forest-wide

-- 1. Create species enum
DO $$ BEGIN
  CREATE TYPE agent_species AS ENUM ('ant', 'bee', 'squirrel');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Add species column (keep type for now, will drop after data migration)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS species agent_species;

-- 3. Migrate current agents to species based on their behavior pattern
UPDATE agents SET species = 'ant'      WHERE name IN ('dev', 'content', 'finance');
UPDATE agents SET species = 'bee'      WHERE name IN ('ops', 'critic');
UPDATE agents SET species = 'squirrel' WHERE name IN ('general', 'research', 'strategy');

-- 4. Make species NOT NULL now that all rows have values
ALTER TABLE agents ALTER COLUMN species SET NOT NULL;
ALTER TABLE agents ALTER COLUMN species SET DEFAULT 'ant';

-- 5. Drop the old type column (was redundant with name)
ALTER TABLE agents DROP COLUMN IF EXISTS type;

-- 6. Link existing person-tree branches to their agent entities
-- dev-group branches → dev_agent entity
UPDATE branches SET entity_id = (SELECT id FROM entities WHERE name = 'dev_agent')
WHERE name = 'dev-group' AND entity_id IS NULL
  AND tree_id IN (SELECT id FROM trees WHERE type = 'person');

-- business branch → finance_agent entity (handles business/finance domain)
UPDATE branches SET entity_id = (SELECT id FROM entities WHERE name = 'finance_agent')
WHERE name = 'business' AND entity_id IS NULL
  AND tree_id IN (SELECT id FROM trees WHERE type = 'person');

-- social branch → general_agent entity (handles social/general domain)
UPDATE branches SET entity_id = (SELECT id FROM entities WHERE name = 'general_agent')
WHERE name = 'social' AND entity_id IS NULL
  AND tree_id IN (SELECT id FROM trees WHERE type = 'person');
