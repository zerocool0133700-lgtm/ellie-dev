-- ELLIE-818: Formation-grove linking
--
-- When a formation spawns, it auto-creates a grove in the Forest.
-- This table tracks the formation→grove mapping so formation members
-- share a knowledge workspace.

CREATE TABLE IF NOT EXISTS formation_groves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  formation_name TEXT NOT NULL,         -- formation slug (e.g. "boardroom")
  session_id TEXT,                      -- optional: specific session ID
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  scope_path TEXT,                      -- knowledge scope path for this grove
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(formation_name, session_id)
);

CREATE INDEX IF NOT EXISTS idx_formation_groves_formation
  ON formation_groves(formation_name);
CREATE INDEX IF NOT EXISTS idx_formation_groves_group
  ON formation_groves(group_id);
