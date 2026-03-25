-- Webhook Triggers — ELLIE-977
-- Inbound webhook endpoints that trigger actions (dispatch, formation, http, reminder).
-- Each webhook gets a unique secret token for authentication.

CREATE TABLE IF NOT EXISTS webhook_triggers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Human-readable name
  name TEXT NOT NULL,
  description TEXT DEFAULT '',

  -- Secret token for authentication (included in URL path)
  token TEXT NOT NULL UNIQUE,

  -- What this webhook triggers (same types as scheduled_tasks)
  action_type TEXT NOT NULL CHECK (action_type IN ('formation', 'dispatch', 'http', 'reminder')),

  -- Action-specific config (same schema as scheduled_tasks.config)
  config JSONB NOT NULL DEFAULT '{}',

  -- Toggle
  enabled BOOLEAN NOT NULL DEFAULT true,

  -- Rate limiting: minimum seconds between invocations
  cooldown_seconds INTEGER NOT NULL DEFAULT 0,

  -- Tracking
  last_triggered_at TIMESTAMPTZ,
  trigger_count INTEGER NOT NULL DEFAULT 0,

  -- Who created it
  created_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_triggers_token
  ON webhook_triggers(token);

CREATE INDEX IF NOT EXISTS idx_webhook_triggers_enabled
  ON webhook_triggers(enabled) WHERE enabled = true;

-- Invocation log
CREATE TABLE IF NOT EXISTS webhook_invocations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  webhook_id UUID NOT NULL REFERENCES webhook_triggers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'completed', 'failed', 'rejected')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,
  error TEXT,
  -- Caller info
  source_ip TEXT,
  -- Payload passed by caller (available to action via config merge)
  payload JSONB DEFAULT '{}',
  result JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_webhook_invocations_webhook
  ON webhook_invocations(webhook_id, created_at DESC);
