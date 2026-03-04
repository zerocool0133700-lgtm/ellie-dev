-- ELLIE-72: Orchestrator polish — performance indexes, compound indexes, NUMERIC precision
--
-- 1. Add mode index on execution_plans for query performance
-- 2. Widen NUMERIC(10,6) → NUMERIC(12,6) for aggregated costs
-- 3. Replace separate memory indexes with compound index (visibility, source_agent)
-- 4. Add skills(agent_id) index (already exists in schema.sql, idempotent)

-- ============================================================
-- execution_plans: add mode index for filtering by execution type
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_execution_plans_mode
  ON execution_plans(mode);

-- ============================================================
-- execution_plans: widen cost precision from NUMERIC(10,6) to NUMERIC(12,6)
-- Avoids overflow when aggregating costs across many steps
-- ============================================================
ALTER TABLE execution_plans
  ALTER COLUMN total_cost_usd TYPE NUMERIC(12,6);

-- ============================================================
-- memory: compound index on (visibility, source_agent)
-- Replaces the separate single-column indexes for the common
-- query pattern in match_memory() which filters by both columns
-- ============================================================
DROP INDEX IF EXISTS idx_memory_visibility;
DROP INDEX IF EXISTS idx_memory_source_agent;

CREATE INDEX IF NOT EXISTS idx_memory_visibility_source_agent
  ON memory(visibility, source_agent);

-- ============================================================
-- skills(agent_id): ensure index exists (idempotent)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_skills_agent_id
  ON skills(agent_id);
