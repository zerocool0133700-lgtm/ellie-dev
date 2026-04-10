-- ELLIE-1542: Per-scope unique constraints on knowledge_scopes
-- Enforces sibling uniqueness: no two scopes under the same parent can
-- share a name. Different subtrees can freely reuse names.

BEGIN;

-- Clean up duplicate test-formation entry (both are empty test data)
DELETE FROM knowledge_scopes
WHERE id = '6a25bb77-ace0-4617-a8be-790d9cec6882';

-- Add composite unique constraint: siblings must have unique names
-- NULLs in parent_id (root scopes) are treated as distinct by PostgreSQL,
-- so we need a partial unique index for roots separately.
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_scopes_parent_name
  ON knowledge_scopes (parent_id, name)
  WHERE parent_id IS NOT NULL;

-- Root scopes (parent_id IS NULL) must also have unique names
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_scopes_root_name
  ON knowledge_scopes (name)
  WHERE parent_id IS NULL;

-- Per-scope-type uniqueness for scope_types table (already has tree_id+name unique)
-- Verify: scope_types already has UNIQUE(tree_id, name) — no change needed there.

COMMIT;
