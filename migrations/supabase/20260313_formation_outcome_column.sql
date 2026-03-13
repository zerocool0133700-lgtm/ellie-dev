-- Formation Outcome Column — ELLIE-696
-- Add typed outcome JSONB to formation_sessions for formation chaining.

ALTER TABLE formation_sessions ADD COLUMN IF NOT EXISTS outcome JSONB DEFAULT NULL;

-- Index for querying sessions by formation name + outcome presence
CREATE INDEX IF NOT EXISTS idx_formation_sessions_has_outcome
  ON formation_sessions(formation_name)
  WHERE outcome IS NOT NULL;

-- GIN index for querying within outcome JSONB
CREATE INDEX IF NOT EXISTS idx_formation_sessions_outcome_gin
  ON formation_sessions USING GIN (outcome)
  WHERE outcome IS NOT NULL;
