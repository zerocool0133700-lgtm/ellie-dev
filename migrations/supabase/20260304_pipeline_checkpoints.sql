-- ELLIE-519: Pipeline checkpoint persistence
-- DB primary storage for pipeline checkpoints (replaces fire-and-forget disk writes).

CREATE TABLE IF NOT EXISTS pipeline_checkpoints (
  pipeline_id TEXT PRIMARY KEY,
  checkpoint_data JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_checkpoints_updated_at
  ON pipeline_checkpoints(updated_at DESC);

ALTER TABLE pipeline_checkpoints ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON pipeline_checkpoints FOR ALL USING (true);
