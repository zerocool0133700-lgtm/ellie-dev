-- Add sequence field for manual ordering within projects
-- Todos with a project_id are ordered within that project;
-- todos without a project are ordered globally (project_id IS NULL group).

ALTER TABLE todos ADD COLUMN IF NOT EXISTS sequence INTEGER DEFAULT 0;

-- Backfill: assign sequence numbers within each project group by created_at
WITH numbered AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY COALESCE(project_id, '00000000-0000-0000-0000-000000000000')
           ORDER BY created_at ASC
         ) AS rn
  FROM todos
)
UPDATE todos SET sequence = numbered.rn
FROM numbered WHERE todos.id = numbered.id;

-- Index for efficient project+sequence ordering
CREATE INDEX IF NOT EXISTS idx_todos_project_sequence
  ON todos (project_id, sequence)
  WHERE project_id IS NOT NULL;

-- Index for unassigned todos ordering
CREATE INDEX IF NOT EXISTS idx_todos_null_project_sequence
  ON todos (sequence)
  WHERE project_id IS NULL;
