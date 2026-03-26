-- ELLIE-1032: Consumer watermark tracking for UMS
-- Enables replay, gap detection, and consumer health monitoring

CREATE TABLE IF NOT EXISTS ums_consumer_watermarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_name TEXT NOT NULL UNIQUE,
  last_message_id UUID REFERENCES unified_messages(id),
  last_processed_at TIMESTAMPTZ,
  messages_processed BIGINT DEFAULT 0,
  errors BIGINT DEFAULT 0,
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'disabled')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_consumer_watermarks_status ON ums_consumer_watermarks(status);
