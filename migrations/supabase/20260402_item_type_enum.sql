-- Add item_type enum to todos table
-- Replaces is_orchestration boolean with explicit type classification

CREATE TYPE todo_item_type AS ENUM ('task', 'agent_dispatch', 'agent_question');

ALTER TABLE todos ADD COLUMN item_type todo_item_type NOT NULL DEFAULT 'task';

-- Backfill: questions assigned to dave (with or without urgency)
UPDATE todos SET item_type = 'agent_question'
  WHERE is_orchestration = true
    AND assigned_to = 'dave';

-- Backfill: everything else that's orchestration = dispatch
UPDATE todos SET item_type = 'agent_dispatch'
  WHERE is_orchestration = true
    AND item_type = 'task';

-- Partial index for kanban queries (only indexes non-task items)
CREATE INDEX idx_todos_item_type ON todos (item_type) WHERE item_type != 'task';

-- Deprecate is_orchestration with concrete removal criteria
COMMENT ON COLUMN todos.is_orchestration IS
  'DEPRECATED: use item_type. Remove when: (1) all relay code uses item_type, (2) all dashboard queries use item_type, (3) no Realtime subscriptions reference it, (4) 2+ weeks post-deploy with no issues.';
