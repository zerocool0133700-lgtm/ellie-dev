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

-- Seed Anthropic models
INSERT INTO models (model_id, display_name, provider, tier, context_window, max_output_tokens, cost_input_mtok, cost_output_mtok, capabilities, is_default, released_at, notes) VALUES
  ('claude-opus-4-6', 'Claude Opus 4.6', 'anthropic', 'frontier', 200000, 32000, 15.0, 75.0, '{"vision","tool_use","thinking","code"}', FALSE, '2026-01-15', 'Most capable model'),
  ('claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', 'anthropic', 'smart', 200000, 16384, 3.0, 15.0, '{"vision","tool_use","thinking","code"}', TRUE, '2025-09-29', 'Default agent model — best balance of capability and cost'),
  ('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 'anthropic', 'fast', 200000, 8192, 0.80, 4.0, '{"vision","tool_use","code"}', FALSE, '2025-10-01', 'Fast/cheap — used for voice, heartbeat checks'),
  ('claude-opus-4-0', 'Claude Opus 4.0', 'anthropic', 'frontier', 200000, 32000, 15.0, 75.0, '{"vision","tool_use","thinking","code"}', FALSE, '2025-05-14', NULL),
  ('claude-sonnet-4-0', 'Claude Sonnet 4.0', 'anthropic', 'smart', 200000, 16384, 3.0, 15.0, '{"vision","tool_use","code"}', FALSE, '2025-05-14', NULL),
  ('claude-3-5-haiku-20241022', 'Claude 3.5 Haiku', 'anthropic', 'cheap', 200000, 8192, 0.25, 1.25, '{"tool_use","code"}', FALSE, '2024-10-22', 'Cheapest option')
ON CONFLICT (model_id) DO NOTHING;

-- Seed OpenAI models
INSERT INTO models (model_id, display_name, provider, tier, context_window, max_output_tokens, cost_input_mtok, cost_output_mtok, capabilities, is_default, enabled, released_at, notes) VALUES
  ('o3', 'OpenAI o3', 'openai', 'frontier', 200000, 100000, 10.0, 40.0, '{"vision","tool_use","thinking","code"}', FALSE, FALSE, '2025-04-16', 'Frontier reasoning model'),
  ('o4-mini', 'OpenAI o4-mini', 'openai', 'smart', 200000, 100000, 1.10, 4.40, '{"vision","tool_use","thinking","code"}', FALSE, FALSE, '2025-04-16', 'Cost-effective reasoning model'),
  ('gpt-4o', 'GPT-4o', 'openai', 'smart', 128000, 16384, 2.50, 10.0, '{"vision","tool_use","code"}', FALSE, FALSE, '2024-05-13', 'Multimodal flagship'),
  ('gpt-4o-mini', 'GPT-4o mini', 'openai', 'fast', 128000, 16384, 0.15, 0.60, '{"vision","tool_use","code"}', FALSE, FALSE, '2024-07-18', 'Fast and cheap multimodal')
ON CONFLICT (model_id) DO NOTHING;

-- Seed Google Gemini models
INSERT INTO models (model_id, display_name, provider, tier, context_window, max_output_tokens, cost_input_mtok, cost_output_mtok, capabilities, is_default, enabled, released_at, notes) VALUES
  ('gemini-2.5-pro', 'Gemini 2.5 Pro', 'google', 'frontier', 1000000, 65536, 1.25, 10.0, '{"vision","tool_use","thinking","code"}', FALSE, FALSE, '2025-03-25', '1M context — pricing shown for ≤200k input'),
  ('gemini-2.5-flash', 'Gemini 2.5 Flash', 'google', 'fast', 1000000, 65536, 0.15, 0.60, '{"vision","tool_use","thinking","code"}', FALSE, FALSE, '2025-04-17', '1M context — fast reasoning with thinking'),
  ('gemini-2.0-flash', 'Gemini 2.0 Flash', 'google', 'cheap', 1000000, 8192, 0.10, 0.40, '{"vision","tool_use","code"}', FALSE, FALSE, '2025-02-05', 'Budget multimodal with 1M context')
ON CONFLICT (model_id) DO NOTHING;

-- Seed Groq models (fast inference)
INSERT INTO models (model_id, display_name, provider, tier, context_window, max_output_tokens, cost_input_mtok, cost_output_mtok, capabilities, is_default, enabled, released_at, notes) VALUES
  ('llama-3.3-70b-versatile', 'Llama 3.3 70B', 'groq', 'smart', 128000, 32768, 0.59, 0.79, '{"tool_use","code"}', FALSE, FALSE, '2024-12-06', 'Groq-hosted — ultra-fast inference'),
  ('deepseek-r1-distill-llama-70b', 'DeepSeek R1 70B', 'groq', 'smart', 128000, 16384, 0.75, 0.99, '{"thinking","code"}', FALSE, FALSE, '2025-01-20', 'Groq-hosted — reasoning model on fast infrastructure')
ON CONFLICT (model_id) DO NOTHING;
