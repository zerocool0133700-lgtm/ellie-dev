-- Marcus Finance Agent — Financial Tracking Tables
-- Created: 2026-03-21
-- Purpose: Monthly summaries, subscriptions, and budget tracking for personal + Ellie OS finances

-- Financial snapshots — monthly summary data
CREATE TABLE IF NOT EXISTS financial_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  month DATE NOT NULL, -- First day of the month (e.g., 2026-03-01)
  type TEXT NOT NULL CHECK (type IN ('personal', 'ellie_os')),
  income NUMERIC(10, 2) NOT NULL DEFAULT 0,
  total_spent NUMERIC(10, 2) NOT NULL DEFAULT 0,
  categories JSONB NOT NULL DEFAULT '{}', -- {"housing": 1200, "food": 400, "subscriptions": 150, ...}
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(month, type)
);

-- Subscriptions — recurring costs inventory
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service TEXT NOT NULL,
  cost NUMERIC(10, 2) NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('monthly', 'yearly', 'quarterly')),
  type TEXT NOT NULL CHECK (type IN ('personal', 'ellie_os')),
  last_used DATE, -- Track when the service was last accessed
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'paused')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Budget targets — expected spending by category
CREATE TABLE IF NOT EXISTS budget_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL,
  target NUMERIC(10, 2) NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('personal', 'ellie_os')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(category, type)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_financial_snapshots_month ON financial_snapshots(month DESC);
CREATE INDEX IF NOT EXISTS idx_financial_snapshots_type ON financial_snapshots(type);
CREATE INDEX IF NOT EXISTS idx_subscriptions_type ON subscriptions(type);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_budget_targets_type ON budget_targets(type);

-- Update timestamps automatically
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_financial_snapshots_updated_at ON financial_snapshots;
CREATE TRIGGER update_financial_snapshots_updated_at BEFORE UPDATE ON financial_snapshots
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_subscriptions_updated_at ON subscriptions;
CREATE TRIGGER update_subscriptions_updated_at BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_budget_targets_updated_at ON budget_targets;
CREATE TRIGGER update_budget_targets_updated_at BEFORE UPDATE ON budget_targets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
