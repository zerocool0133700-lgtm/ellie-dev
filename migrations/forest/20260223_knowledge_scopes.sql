-- Knowledge Scopes — Hierarchical land model for knowledge sharing
-- Path format: backslash-separated numeric segments
-- e.g. 1\1\21 = World > USA > Texas
-- Access: a scope can see all ancestors (prefixes) and descendants

CREATE TABLE IF NOT EXISTS knowledge_scopes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  path TEXT NOT NULL UNIQUE,          -- e.g. '1', '1\1', '1\1\21'
  name TEXT NOT NULL,                 -- e.g. 'World', 'USA', 'Texas'
  level TEXT NOT NULL,                -- e.g. 'world', 'country', 'state', 'city', 'grove', 'tree', 'branch'
  parent_id UUID REFERENCES knowledge_scopes(id) ON DELETE CASCADE,
  -- Optional links to forest entities
  group_id UUID REFERENCES groups(id) ON DELETE SET NULL,   -- for grove-level scopes
  tree_id UUID REFERENCES trees(id) ON DELETE SET NULL,     -- for tree-level scopes
  branch_id UUID REFERENCES branches(id) ON DELETE SET NULL, -- for branch-level scopes
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_scopes_path ON knowledge_scopes USING btree (path);
CREATE INDEX IF NOT EXISTS idx_knowledge_scopes_parent ON knowledge_scopes (parent_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_scopes_level ON knowledge_scopes (level);

-- Add scope_path to shared_memories (replaces scope enum + scope_id)
ALTER TABLE shared_memories ADD COLUMN IF NOT EXISTS scope_path TEXT;
CREATE INDEX IF NOT EXISTS idx_shared_memories_scope_path ON shared_memories (scope_path) WHERE archived_at IS NULL;

-- Migrate existing memories:
-- 'global' scope → will get path '1' (world)
-- 'forest' scope → will get path '1\1' (first country, placeholder)
-- 'tree' scope → needs tree-specific path (deferred to seeding)
-- 'branch' scope → needs branch-specific path (deferred to seeding)
