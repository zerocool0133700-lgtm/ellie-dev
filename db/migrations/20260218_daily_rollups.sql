-- Daily Rollups: Structured digests of completed work sessions
-- ELLIE-27: Work session daily rollups

CREATE TABLE IF NOT EXISTS daily_rollups (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  rollup_date DATE NOT NULL,
  sessions_count INTEGER NOT NULL DEFAULT 0,
  total_duration_min INTEGER NOT NULL DEFAULT 0,
  digest JSONB NOT NULL DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  UNIQUE (rollup_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_rollups_date ON daily_rollups(rollup_date DESC);

ALTER TABLE daily_rollups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON daily_rollups FOR ALL USING (true);
