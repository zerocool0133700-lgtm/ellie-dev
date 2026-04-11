-- ELLIE-1536: Migration #3 — Drop level, make scope_type_id NOT NULL
-- Part A only (level deprecation). Part B (hierarchy trigger) deferred
-- pending design decision on multi-tree hierarchy enforcement.
--
-- Pre-conditions:
--   - scope_types table exists with backfilled entries from level values
--   - All code updated to JOIN scope_types instead of reading level directly
--   - All INSERT statements updated to write scope_type_id instead of level

BEGIN;

-- Step 1: Create 'land' scope_type if it doesn't exist (needed for L/1 scope)
INSERT INTO scope_types (name, tree_id, description)
SELECT 'land', 'e1110e05-0000-0000-0000-000000000001', 'Land scope type for property management'
WHERE NOT EXISTS (SELECT 1 FROM scope_types WHERE name = 'land')
ON CONFLICT (tree_id, name) DO NOTHING;

-- Step 2: Backfill all rows missing scope_type_id from their level value
UPDATE knowledge_scopes ks
   SET scope_type_id = st.id
  FROM scope_types st
 WHERE st.name = ks.level
   AND ks.scope_type_id IS NULL;

-- Step 3: Verify no NULLs remain (will fail the transaction if any do)
DO $$
DECLARE
  null_count INT;
BEGIN
  SELECT COUNT(*) INTO null_count FROM knowledge_scopes WHERE scope_type_id IS NULL;
  IF null_count > 0 THEN
    RAISE EXCEPTION 'Cannot set NOT NULL: % knowledge_scopes rows still have NULL scope_type_id', null_count;
  END IF;
END $$;

-- Step 4: Set scope_type_id NOT NULL
ALTER TABLE knowledge_scopes ALTER COLUMN scope_type_id SET NOT NULL;

-- Step 5: Drop the deprecated level column
ALTER TABLE knowledge_scopes DROP COLUMN IF EXISTS level;

-- Step 6: Drop the now-unused level index
DROP INDEX IF EXISTS idx_knowledge_scopes_level;

COMMIT;
