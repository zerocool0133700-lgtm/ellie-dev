-- ELLIE-36: Personal to-do list
-- Run against Supabase SQL editor

CREATE TABLE IF NOT EXISTS todos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  content TEXT NOT NULL,
  status TEXT CHECK (status IN ('open', 'done', 'cancelled')) DEFAULT 'open',
  priority TEXT CHECK (priority IN ('low', 'medium', 'high')) DEFAULT NULL,
  due_date TIMESTAMPTZ,
  tags TEXT[] DEFAULT '{}',
  source_conversation_id TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
CREATE INDEX IF NOT EXISTS idx_todos_due_date ON todos(due_date) WHERE due_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_todos_priority ON todos(priority) WHERE priority IS NOT NULL;

-- Enable RLS
ALTER TABLE todos ENABLE ROW LEVEL SECURITY;

-- Allow all operations (single-user system)
CREATE POLICY "Allow all" ON todos FOR ALL USING (true) WITH CHECK (true);
