-- ELLIE-903: Agent workload snapshots — daily capture for trends

CREATE TABLE IF NOT EXISTS gtd_workload_snapshots (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  agent_type TEXT NOT NULL,
  snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
  open_count INT DEFAULT 0,
  waiting_count INT DEFAULT 0,
  done_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (agent_type, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_gtd_snapshots_agent
  ON gtd_workload_snapshots(agent_type);
CREATE INDEX IF NOT EXISTS idx_gtd_snapshots_date
  ON gtd_workload_snapshots(snapshot_date);
