-- ELLIE-915: Enhanced GTD schema — effort, context, scheduled_at, reference
-- ELLIE-916: Context management table
-- ELLIE-921: Reference tagging

-- Add effort classification to todos
ALTER TABLE todos ADD COLUMN IF NOT EXISTS effort TEXT
  CHECK (effort IN ('quick', 'medium', 'deep'));

-- Add context as a plain string (replaces @ tag approach per Gap 4 decision)
ALTER TABLE todos ADD COLUMN IF NOT EXISTS context TEXT;

-- Add scheduled_at (distinct from due_date — when to do it vs when it's due)
ALTER TABLE todos ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;

-- Add reference flag (Option B — lightweight tagging)
ALTER TABLE todos ADD COLUMN IF NOT EXISTS is_reference BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_todos_effort ON todos(effort) WHERE effort IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_todos_context ON todos(context) WHERE context IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_todos_scheduled ON todos(scheduled_at) WHERE scheduled_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_todos_reference ON todos(is_reference) WHERE is_reference = TRUE;

-- Context management table (ELLIE-916)
CREATE TABLE IF NOT EXISTS gtd_contexts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  icon TEXT,
  color TEXT,
  calendar_enabled BOOLEAN DEFAULT FALSE,
  calendar_id TEXT,  -- Google Calendar ID for sync
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default contexts (no @ symbols per Gap 4 decision)
INSERT INTO gtd_contexts (name, label, icon, color, calendar_enabled, sort_order) VALUES
  ('general', 'General', '📋', '#6B7280', FALSE, 1),
  ('deep-work', 'Deep Work', '🔨', '#3B82F6', FALSE, 2),
  ('email', 'Email', '📧', '#8B5CF6', TRUE, 3),
  ('appointments', 'Appointments', '📅', '#EC4899', TRUE, 4),
  ('errands', 'Errands', '🏃', '#F59E0B', FALSE, 5),
  ('phone', 'Phone', '📞', '#10B981', FALSE, 6),
  ('plane', 'Plane Tickets', '✈️', '#06B6D4', FALSE, 7),
  ('home', 'Home', '🏠', '#EF4444', FALSE, 8)
ON CONFLICT (name) DO NOTHING;

-- Context-calendar mapping (ELLIE-920)
CREATE TABLE IF NOT EXISTS context_calendar_config (
  context_name TEXT PRIMARY KEY REFERENCES gtd_contexts(name) ON DELETE CASCADE,
  google_calendar_id TEXT,
  sync_direction TEXT DEFAULT 'bidirectional' CHECK (sync_direction IN ('to_calendar', 'from_calendar', 'bidirectional')),
  enabled BOOLEAN DEFAULT TRUE,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
