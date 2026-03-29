-- 20260328_foundations.sql
-- Creates the foundations table for managing named agent configurations (active foundation = current persona set)

CREATE TABLE IF NOT EXISTS foundations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  agents JSONB NOT NULL DEFAULT '[]'::jsonb,
  recipes JSONB NOT NULL DEFAULT '[]'::jsonb,
  behavior JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enforce at most one active foundation at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_foundations_active
  ON foundations (active) WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_foundations_name ON foundations (name);
