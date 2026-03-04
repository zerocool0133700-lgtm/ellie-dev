-- ELLIE-270: GTD full methodology — schema migration
-- Adds inbox/someday statuses, projects table, source tracking
-- Run against Supabase SQL editor

-- ── 1. New table: todo_projects ──────────────────────────────

CREATE TABLE IF NOT EXISTS todo_projects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT CHECK (status IN ('active', 'completed', 'on_hold')) DEFAULT 'active',
  outcome TEXT,                          -- desired outcome (GTD: "what does done look like?")
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_todo_projects_status ON todo_projects(status);

-- RLS (single-user system)
ALTER TABLE todo_projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON todo_projects FOR ALL USING (true) WITH CHECK (true);

-- ── 2. Extend todos table ────────────────────────────────────

-- Add project_id FK (nullable — not all todos belong to a project)
ALTER TABLE todos ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES todo_projects(id) ON DELETE SET NULL;

-- Add source tracking (where did this todo come from?)
ALTER TABLE todos ADD COLUMN IF NOT EXISTS source_type TEXT;  -- 'voice', 'telegram', 'chat', 'email', 'manual', 'weekly_review'
ALTER TABLE todos ADD COLUMN IF NOT EXISTS source_ref TEXT;   -- conversation ID, message ID, etc.

-- ── 3. Expand status constraint ──────────────────────────────

-- Drop old constraint and add new one with inbox + someday
ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_status_check;
ALTER TABLE todos ADD CONSTRAINT todos_status_check
  CHECK (status IN ('inbox', 'open', 'done', 'cancelled', 'waiting_for', 'someday'));

-- ── 4. New indexes ───────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_todos_project_id ON todos(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_todos_source_type ON todos(source_type) WHERE source_type IS NOT NULL;

-- ── 5. Realtime (Supabase) ───────────────────────────────────

-- Enable realtime for the new table (if using supabase_realtime publication)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE todo_projects;
  END IF;
END $$;
