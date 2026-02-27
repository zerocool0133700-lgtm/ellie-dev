-- ELLIE-291: Add waiting_since timestamp to todos
-- ELLIE-290: Add gtd_contexts table for validated context tags
-- Run against Supabase SQL editor

-- ── 1. waiting_since column (ELLIE-291) ─────────────────────

ALTER TABLE todos ADD COLUMN IF NOT EXISTS waiting_since TIMESTAMPTZ;

-- Backfill: for existing waiting_for items, use updated_at as a best-guess
UPDATE todos SET waiting_since = updated_at
WHERE status = 'waiting_for' AND waiting_since IS NULL;

CREATE INDEX IF NOT EXISTS idx_todos_waiting_since ON todos(waiting_since)
WHERE waiting_since IS NOT NULL;

-- ── 2. gtd_contexts table (ELLIE-290) ───────────────────────

CREATE TABLE IF NOT EXISTS gtd_contexts (
  tag TEXT PRIMARY KEY CHECK (tag ~ '^@[a-z][a-z0-9-]*$'),
  label TEXT NOT NULL,
  icon TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS (single-user system)
ALTER TABLE gtd_contexts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON gtd_contexts FOR ALL USING (true) WITH CHECK (true);

-- Seed with the four pre-existing contexts
INSERT INTO gtd_contexts (tag, label, sort_order) VALUES
  ('@home', 'Home', 1),
  ('@computer', 'Computer', 2),
  ('@deep-work', 'Deep Work', 3),
  ('@errands', 'Errands', 4)
ON CONFLICT (tag) DO NOTHING;
