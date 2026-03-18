-- ELLIE-883: Add assignment and delegation columns to todos
--
-- Enables multi-agent task assignment. All columns nullable
-- so existing todos continue working unchanged.

ALTER TABLE todos ADD COLUMN IF NOT EXISTS assigned_to TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS assigned_agent TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS delegated_by TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS delegated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_todos_assigned_agent
  ON todos(assigned_agent) WHERE assigned_agent IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_todos_assigned_to
  ON todos(assigned_to) WHERE assigned_to IS NOT NULL;
