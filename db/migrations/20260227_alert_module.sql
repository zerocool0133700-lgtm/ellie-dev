-- ELLIE-317: Alert Module — rules engine, alert log, VIP senders
-- Run against Supabase SQL editor

-- ── 1. Alert rules table ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS alert_rules (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'vip_sender', 'keyword', 'ci_failure', 'calendar_conflict',
    'security', 'gtd_overdue', 'stale_thread', 'custom'
  )),
  config JSONB NOT NULL DEFAULT '{}',  -- type-specific: { senders: [], keywords: [], pattern: "" }
  priority TEXT NOT NULL CHECK (priority IN ('critical', 'high', 'normal')) DEFAULT 'high',
  enabled BOOLEAN NOT NULL DEFAULT true,
  cooldown_minutes INTEGER DEFAULT 30,  -- suppress repeat fires within this window
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(enabled) WHERE enabled = true;

-- RLS (single-user system)
ALTER TABLE alert_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON alert_rules FOR ALL USING (true) WITH CHECK (true);

-- ── 2. Fired alerts log ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS alerts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  rule_id UUID REFERENCES alert_rules(id) ON DELETE SET NULL,
  rule_name TEXT NOT NULL,
  message_id UUID,                   -- unified_messages.id that triggered it
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'normal')),
  summary TEXT NOT NULL,             -- formatted alert text
  provider TEXT,                     -- source provider (github, gmail, etc.)
  sender JSONB,                      -- who triggered it
  acknowledged BOOLEAN DEFAULT false,
  acknowledged_at TIMESTAMPTZ,
  ack_note TEXT,                     -- optional note when acknowledging
  delivered_at TIMESTAMPTZ DEFAULT NOW(),
  delivery_channels TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_unacked ON alerts(acknowledged, created_at DESC) WHERE acknowledged = false;
CREATE INDEX IF NOT EXISTS idx_alerts_rule ON alerts(rule_id);

-- RLS
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON alerts FOR ALL USING (true) WITH CHECK (true);

-- ── 3. Alert preferences ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS alert_preferences (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE alert_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON alert_preferences FOR ALL USING (true) WITH CHECK (true);

-- Seed default preferences
INSERT INTO alert_preferences (key, value) VALUES
  ('quiet_hours', '{"enabled": true, "start": "00:00", "end": "07:00", "timezone": "America/Chicago", "bypass_critical": true}'),
  ('dedup_window_minutes', '30'),
  ('default_cooldown_minutes', '30')
ON CONFLICT (key) DO NOTHING;

-- ── 4. Seed built-in rules ────────────────────────────────────

INSERT INTO alert_rules (name, type, config, priority, cooldown_minutes) VALUES
  ('CI Failure', 'ci_failure', '{}', 'critical', 5),
  ('VIP Sender', 'vip_sender', '{"senders": []}', 'high', 0),
  ('Urgent Keywords', 'keyword', '{"keywords": ["urgent", "emergency", "incident", "outage", "down", "broken", "critical", "blocked"]}', 'high', 30),
  ('Security Alert', 'security', '{}', 'critical', 0),
  ('Calendar Conflict', 'calendar_conflict', '{}', 'normal', 60)
ON CONFLICT DO NOTHING;
