-- ELLIE-34: Models registry table
-- Run against Supabase SQL editor

CREATE TABLE IF NOT EXISTS models (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  model_id TEXT UNIQUE NOT NULL,          -- API model string (e.g. "claude-sonnet-4-5-20250929")
  display_name TEXT NOT NULL,             -- Human-friendly name (e.g. "Claude Sonnet 4.5")
  provider TEXT NOT NULL DEFAULT 'anthropic',
  tier TEXT CHECK (tier IN ('frontier', 'smart', 'fast', 'cheap')) DEFAULT 'smart',
  context_window INTEGER,
  max_output_tokens INTEGER,
  cost_input_mtok NUMERIC(10,4),          -- Cost per 1M input tokens
  cost_output_mtok NUMERIC(10,4),         -- Cost per 1M output tokens
  capabilities TEXT[] DEFAULT '{}',       -- e.g. {"vision", "tool_use", "thinking", "code"}
  is_default BOOLEAN DEFAULT FALSE,
  enabled BOOLEAN DEFAULT TRUE,
  released_at DATE,
  deprecated_at DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_models_model_id ON models(model_id);
CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider);
CREATE INDEX IF NOT EXISTS idx_models_enabled ON models(enabled) WHERE enabled = TRUE;

-- Seed current Anthropic models
INSERT INTO models (model_id, display_name, provider, tier, context_window, max_output_tokens, cost_input_mtok, cost_output_mtok, capabilities, is_default, released_at, notes) VALUES
  ('claude-opus-4-6', 'Claude Opus 4.6', 'anthropic', 'frontier', 200000, 32000, 15.0, 75.0, '{"vision","tool_use","thinking","code"}', FALSE, '2026-01-15', 'Most capable model'),
  ('claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', 'anthropic', 'smart', 200000, 16384, 3.0, 15.0, '{"vision","tool_use","thinking","code"}', TRUE, '2025-09-29', 'Default agent model — best balance of capability and cost'),
  ('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 'anthropic', 'fast', 200000, 8192, 0.80, 4.0, '{"vision","tool_use","code"}', FALSE, '2025-10-01', 'Fast/cheap — used for voice, heartbeat checks'),
  ('claude-opus-4-0', 'Claude Opus 4.0', 'anthropic', 'frontier', 200000, 32000, 15.0, 75.0, '{"vision","tool_use","thinking","code"}', FALSE, '2025-05-14', NULL),
  ('claude-sonnet-4-0', 'Claude Sonnet 4.0', 'anthropic', 'smart', 200000, 16384, 3.0, 15.0, '{"vision","tool_use","code"}', FALSE, '2025-05-14', NULL),
  ('claude-3-5-haiku-20241022', 'Claude 3.5 Haiku', 'anthropic', 'cheap', 200000, 8192, 0.25, 1.25, '{"tool_use","code"}', FALSE, '2024-10-22', 'Cheapest option')
ON CONFLICT (model_id) DO NOTHING;
