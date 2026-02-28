-- ELLIE-335: Nightly Channel Gardener
-- Usage snapshots + suggestion tracking for channel tree improvements

-- Daily per-channel usage metrics
CREATE TABLE IF NOT EXISTS channel_usage_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  message_count INT NOT NULL DEFAULT 0,
  conversation_count INT NOT NULL DEFAULT 0,
  last_activity_at TIMESTAMPTZ,
  avg_message_length FLOAT,
  unique_topics INT,
  metadata JSONB DEFAULT '{}',
  UNIQUE(channel_id, snapshot_date)
);

-- Gardener suggestions (archive, split, new channel, etc.)
CREATE TABLE IF NOT EXISTS channel_gardener_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID REFERENCES chat_channels(id) ON DELETE CASCADE,
  suggestion_type TEXT NOT NULL CHECK (suggestion_type IN ('archive', 'split', 'new_channel', 'reclassify', 'merge')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}',
  confidence FLOAT NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'dismissed', 'applied')),
  dismissed_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actioned_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_gardener_suggestions_status ON channel_gardener_suggestions(status);
CREATE INDEX IF NOT EXISTS idx_gardener_suggestions_channel ON channel_gardener_suggestions(channel_id);
CREATE INDEX IF NOT EXISTS idx_usage_snapshots_date ON channel_usage_snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_usage_snapshots_channel ON channel_usage_snapshots(channel_id);
