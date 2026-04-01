-- ELLIE-768: Capture queue data model & migration
-- Central staging area for all River-bound content

-- Enums
DO $$ BEGIN
  CREATE TYPE capture_type AS ENUM ('manual', 'tag', 'proactive', 'replay', 'braindump', 'template');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE capture_content_type AS ENUM ('workflow', 'decision', 'process', 'policy', 'integration', 'reference');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE capture_status AS ENUM ('queued', 'refined', 'approved', 'written', 'dismissed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Table
CREATE TABLE IF NOT EXISTS capture_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'ellie-chat', 'google-chat', 'voice')),
  raw_content TEXT NOT NULL,
  refined_content TEXT,
  suggested_path TEXT,
  suggested_section TEXT,
  capture_type capture_type NOT NULL DEFAULT 'manual',
  content_type capture_content_type NOT NULL DEFAULT 'reference',
  status capture_status NOT NULL DEFAULT 'queued',
  confidence REAL CHECK (confidence >= 0 AND confidence <= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_capture_queue_status ON capture_queue(status);
CREATE INDEX IF NOT EXISTS idx_capture_queue_channel ON capture_queue(channel);
CREATE INDEX IF NOT EXISTS idx_capture_queue_created_at ON capture_queue(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_capture_queue_status_created ON capture_queue(status, created_at DESC);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_capture_queue_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_capture_queue_updated_at ON capture_queue;
CREATE TRIGGER trg_capture_queue_updated_at
  BEFORE UPDATE ON capture_queue
  FOR EACH ROW EXECUTE FUNCTION update_capture_queue_updated_at();

-- RLS
ALTER TABLE capture_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS capture_queue_authenticated_read ON capture_queue;
CREATE POLICY capture_queue_authenticated_read ON capture_queue
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS capture_queue_authenticated_insert ON capture_queue;
CREATE POLICY capture_queue_authenticated_insert ON capture_queue
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS capture_queue_authenticated_update ON capture_queue;
CREATE POLICY capture_queue_authenticated_update ON capture_queue
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
