-- ELLIE-1151: GTD orchestration support
ALTER TABLE todos ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES todos(id);
ALTER TABLE todos ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS is_orchestration BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS urgency TEXT CHECK (urgency IN ('blocking', 'normal', 'low'));
ALTER TABLE todos ADD COLUMN IF NOT EXISTS dispatch_envelope_id TEXT;
ALTER TABLE todos ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_todos_parent ON todos(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_todos_created_by ON todos(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_todos_orchestration ON todos(is_orchestration) WHERE is_orchestration = true;

-- Extend status check constraint to include failure states
DO $$
BEGIN
  ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_status_check;
  ALTER TABLE todos ADD CONSTRAINT todos_status_check
    CHECK (status IN ('inbox', 'open', 'waiting_for', 'someday', 'done', 'cancelled', 'failed', 'timed_out'));
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Status constraint update skipped: %', SQLERRM;
END $$;
