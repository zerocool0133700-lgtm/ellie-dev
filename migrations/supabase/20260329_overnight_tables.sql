-- Off-hours sessions
CREATE TABLE IF NOT EXISTS overnight_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ NOT NULL,
  stopped_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'stopped')),
  concurrency_limit INT NOT NULL DEFAULT 2,
  tasks_total INT NOT NULL DEFAULT 0,
  tasks_completed INT NOT NULL DEFAULT 0,
  tasks_failed INT NOT NULL DEFAULT 0,
  stop_reason TEXT
    CHECK (stop_reason IN ('time_limit', 'user_activity', 'manual', 'all_done', 'relay_restart'))
);

-- Per-task results
CREATE TABLE IF NOT EXISTS overnight_task_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES overnight_sessions(id),
  gtd_task_id UUID NOT NULL,
  assigned_agent TEXT NOT NULL,
  task_title TEXT NOT NULL,
  task_content TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'merged', 'rejected')),
  branch_name TEXT,
  pr_url TEXT,
  pr_number INT,
  summary TEXT,
  error TEXT,
  container_id TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  duration_ms INT
);

CREATE INDEX IF NOT EXISTS idx_overnight_results_session ON overnight_task_results(session_id);
CREATE INDEX IF NOT EXISTS idx_overnight_results_status ON overnight_task_results(status);
CREATE INDEX IF NOT EXISTS idx_overnight_sessions_status ON overnight_sessions(status);
