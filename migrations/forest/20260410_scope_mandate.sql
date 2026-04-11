-- ELLIE-1534: Scope Mandate — First-class scope_path on every Forest document
-- Every core Forest table gets scope_path TEXT so documents are scope-aware.
-- scope_path references knowledge_scopes.path (e.g. '2/1', 'L/1/3').
-- Nullable for existing rows; new inserts should populate it.

-- trees
ALTER TABLE trees ADD COLUMN IF NOT EXISTS scope_path TEXT;
CREATE INDEX IF NOT EXISTS idx_trees_scope_path ON trees (scope_path) WHERE scope_path IS NOT NULL;

-- branches
ALTER TABLE branches ADD COLUMN IF NOT EXISTS scope_path TEXT;
CREATE INDEX IF NOT EXISTS idx_branches_scope_path ON branches (scope_path) WHERE scope_path IS NOT NULL;

-- trunks
ALTER TABLE trunks ADD COLUMN IF NOT EXISTS scope_path TEXT;
CREATE INDEX IF NOT EXISTS idx_trunks_scope_path ON trunks (scope_path) WHERE scope_path IS NOT NULL;

-- commits
ALTER TABLE commits ADD COLUMN IF NOT EXISTS scope_path TEXT;
CREATE INDEX IF NOT EXISTS idx_commits_scope_path ON commits (scope_path) WHERE scope_path IS NOT NULL;

-- entities
ALTER TABLE entities ADD COLUMN IF NOT EXISTS scope_path TEXT;
CREATE INDEX IF NOT EXISTS idx_entities_scope_path ON entities (scope_path) WHERE scope_path IS NOT NULL;

-- creatures
ALTER TABLE creatures ADD COLUMN IF NOT EXISTS scope_path TEXT;
CREATE INDEX IF NOT EXISTS idx_creatures_scope_path ON creatures (scope_path) WHERE scope_path IS NOT NULL;

-- forest_events
ALTER TABLE forest_events ADD COLUMN IF NOT EXISTS scope_path TEXT;
CREATE INDEX IF NOT EXISTS idx_forest_events_scope_path ON forest_events (scope_path) WHERE scope_path IS NOT NULL;

-- rbac_entities
ALTER TABLE rbac_entities ADD COLUMN IF NOT EXISTS scope_path TEXT;
CREATE INDEX IF NOT EXISTS idx_rbac_entities_scope_path ON rbac_entities (scope_path) WHERE scope_path IS NOT NULL;

-- Backfill trees from knowledge_scopes where a scope references a tree
UPDATE trees t
   SET scope_path = ks.path
  FROM knowledge_scopes ks
 WHERE ks.tree_id = t.id
   AND t.scope_path IS NULL;

-- Backfill branches from knowledge_scopes where a scope references a branch
UPDATE branches b
   SET scope_path = ks.path
  FROM knowledge_scopes ks
 WHERE ks.branch_id = b.id
   AND b.scope_path IS NULL;

-- Backfill rbac_entities from agent scopes (path '3/<agent_name>')
UPDATE rbac_entities re
   SET scope_path = ks.path
  FROM knowledge_scopes ks
 WHERE LOWER(ks.name) = LOWER(re.name)
   AND ks.path LIKE '3/%'
   AND re.scope_path IS NULL;
