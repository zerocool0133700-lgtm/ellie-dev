-- Agent Queue System (ELLIE-200)
-- Two-way async communication queue between agents (Ellie ↔ James)
-- Allows agents to flag items for each other without Dave as middleman

CREATE TABLE IF NOT EXISTS agent_queue (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  source TEXT NOT NULL, -- Agent that created this item (e.g., 'ellie', 'james')
  target TEXT NOT NULL, -- Agent that should handle this item
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('critical', 'high', 'medium', 'low')),
  category TEXT NOT NULL, -- bug/analysis/hypothesis/question/suggestion (Ellie→James) or bug_fix/investigation/discovery/decision/log (James→Ellie)
  title TEXT NOT NULL, -- Brief description
  content TEXT NOT NULL, -- Detailed message
  work_item_id TEXT, -- Optional reference to ELLIE-XXX ticket
  status TEXT DEFAULT 'new' CHECK (status IN ('new', 'acknowledged', 'completed')),
  acknowledged_at TIMESTAMPTZ, -- When item was acknowledged
  completed_at TIMESTAMPTZ, -- When item was completed
  related_refs JSONB DEFAULT '[]', -- Array of related items/documents
  metadata JSONB DEFAULT '{}'
);

-- Index for filtering by target and status (primary query pattern)
CREATE INDEX IF NOT EXISTS idx_agent_queue_target_status ON agent_queue(target, status);

-- Index for work item lookups
CREATE INDEX IF NOT EXISTS idx_agent_queue_work_item_id ON agent_queue(work_item_id) WHERE work_item_id IS NOT NULL;

-- Index for created_at ordering
CREATE INDEX IF NOT EXISTS idx_agent_queue_created_at ON agent_queue(created_at DESC);

COMMENT ON TABLE agent_queue IS 'Async communication queue between agents for flagging items without Dave as middleman';
COMMENT ON COLUMN agent_queue.source IS 'Agent that created this queue item';
COMMENT ON COLUMN agent_queue.target IS 'Agent that should handle this queue item';
COMMENT ON COLUMN agent_queue.category IS 'Ellie→James: bug, analysis, hypothesis, question, suggestion | James→Ellie: bug_fix, investigation, discovery, decision, log';
COMMENT ON COLUMN agent_queue.status IS 'Lifecycle: new → acknowledged → completed';
COMMENT ON COLUMN agent_queue.related_refs IS 'Array of related file paths, URLs, or document references';
COMMENT ON COLUMN agent_queue.acknowledged_at IS 'Timestamp when item was acknowledged by target agent';
COMMENT ON COLUMN agent_queue.completed_at IS 'Timestamp when item was completed';
