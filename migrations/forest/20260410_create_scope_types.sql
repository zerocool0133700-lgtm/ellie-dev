-- Create scope_types table — referenced by knowledge_scopes.scope_type_id
-- and used by grove-spaces.ts / forest-grove.ts for scope classification.
--
-- This table existed in the live DB but was never captured as a migration,
-- causing test DB setup failures. Schema matches production.

CREATE TABLE IF NOT EXISTS scope_types (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tree_id              uuid NOT NULL REFERENCES trees(id) ON DELETE RESTRICT,
  name                 text NOT NULL,
  parent_scope_type_id uuid REFERENCES scope_types(id) ON DELETE RESTRICT,
  description          text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tree_id, name)
);

CREATE INDEX IF NOT EXISTS idx_scope_types_tree ON scope_types (tree_id);
CREATE INDEX IF NOT EXISTS idx_scope_types_name ON scope_types (name);
CREATE INDEX IF NOT EXISTS idx_scope_types_parent ON scope_types (parent_scope_type_id) WHERE parent_scope_type_id IS NOT NULL;
