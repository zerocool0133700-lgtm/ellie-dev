-- ELLIE-1537: scope_path backfill — populate all 6 empty tables + fill gaps
-- Execution order respects FK dependencies: trees first, then children.

BEGIN;

-- ============================================================================
-- 1. TREES — Backfill from knowledge_scopes where possible, default to '2/1'
-- ============================================================================

-- 1a. Trees with a matching knowledge_scope entry
UPDATE trees t
   SET scope_path = ks.path
  FROM knowledge_scopes ks
 WHERE ks.tree_id = t.id
   AND t.scope_path IS NULL;

-- 1b. Remaining work_session trees with ELLIE- work items → ellie-dev (2/1)
UPDATE trees
   SET scope_path = '2/1'
 WHERE scope_path IS NULL
   AND type = 'work_session'
   AND work_item_id LIKE 'ELLIE-%';

-- 1c. Any remaining trees → project root (2)
UPDATE trees
   SET scope_path = '2'
 WHERE scope_path IS NULL;

-- ============================================================================
-- 2. TRUNKS — Inherit from their tree
-- ============================================================================
UPDATE trunks tk
   SET scope_path = t.scope_path
  FROM trees t
 WHERE t.id = tk.tree_id
   AND tk.scope_path IS NULL;

-- ============================================================================
-- 3. BRANCHES — Inherit from their tree
-- ============================================================================
UPDATE branches b
   SET scope_path = t.scope_path
  FROM trees t
 WHERE t.id = b.tree_id
   AND b.scope_path IS NULL;

-- ============================================================================
-- 4. COMMITS — Inherit from their tree
-- ============================================================================
UPDATE commits c
   SET scope_path = t.scope_path
  FROM trees t
 WHERE t.id = c.tree_id
   AND c.scope_path IS NULL;

-- ============================================================================
-- 5. CREATURES — Inherit from their tree
-- ============================================================================
UPDATE creatures cr
   SET scope_path = t.scope_path
  FROM trees t
 WHERE t.id = cr.tree_id
   AND cr.scope_path IS NULL;

-- ============================================================================
-- 6. ENTITIES — Derive from primary tree attachment
-- ============================================================================
UPDATE entities e
   SET scope_path = t.scope_path
  FROM tree_entities te
  JOIN trees t ON t.id = te.tree_id
 WHERE te.entity_id = e.id
   AND te.active = true
   AND e.scope_path IS NULL;

-- 6b. Remaining entities → project root
UPDATE entities
   SET scope_path = '2'
 WHERE scope_path IS NULL;

-- ============================================================================
-- 7. RBAC_ENTITIES — Fill remaining gaps
-- ============================================================================

-- Dave is the landlord, root of everything
UPDATE rbac_entities SET scope_path = '1' WHERE name = 'Dave' AND scope_path IS NULL;

-- Ellie is the super_agent, global scope
UPDATE rbac_entities SET scope_path = '1' WHERE name = 'Ellie' AND scope_path IS NULL;

-- Betty (tenant) → land scope
UPDATE rbac_entities SET scope_path = 'L' WHERE name = 'Betty' AND scope_path IS NULL;

-- Allen (manager) → land scope
UPDATE rbac_entities SET scope_path = 'L' WHERE name = 'Allen' AND scope_path IS NULL;

COMMIT;
