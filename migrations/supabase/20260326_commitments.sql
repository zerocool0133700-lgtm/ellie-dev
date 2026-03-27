-- ELLIE-1067: Commitment tracking
CREATE TABLE IF NOT EXISTS commitments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content TEXT NOT NULL,
  person_name TEXT NOT NULL,
  assignee TEXT DEFAULT 'dave',
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'done', 'overdue', 'cancelled')),
  due_date TIMESTAMPTZ,
  source_conversation_id UUID,
  source_channel TEXT,
  stale_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_commitments_person ON commitments(person_name);
CREATE INDEX idx_commitments_status ON commitments(status);
CREATE INDEX idx_commitments_due ON commitments(due_date) WHERE status = 'open';
