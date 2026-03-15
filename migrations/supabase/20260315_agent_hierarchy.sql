-- Agent Org Chart Hierarchy — ELLIE-725
-- Add reporting lines to agents for delegation flows (CEO -> VP -> Specialist).

-- ============================================================
-- NEW COLUMNS ON AGENTS TABLE
-- ============================================================

-- Self-referential FK: who this agent reports to
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS reports_to UUID REFERENCES agents(id);

-- Job title within the org chart
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS title TEXT;

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_agents_reports_to
  ON agents(reports_to)
  WHERE reports_to IS NOT NULL;

-- ============================================================
-- CIRCULAR REFERENCE PREVENTION
-- ============================================================
-- Trigger function that walks up the chain to detect cycles
-- before allowing a reports_to update.

CREATE OR REPLACE FUNCTION check_agent_hierarchy_cycle()
RETURNS TRIGGER AS $$
DECLARE
  current_id UUID;
  max_depth INT := 20;
  depth INT := 0;
BEGIN
  -- NULL reports_to is always valid (root agent)
  IF NEW.reports_to IS NULL THEN
    RETURN NEW;
  END IF;

  -- Cannot report to self
  IF NEW.reports_to = NEW.id THEN
    RAISE EXCEPTION 'Agent cannot report to itself';
  END IF;

  -- Walk up the chain from the new parent to detect cycles
  current_id := NEW.reports_to;
  WHILE current_id IS NOT NULL AND depth < max_depth LOOP
    IF current_id = NEW.id THEN
      RAISE EXCEPTION 'Circular reference detected in agent hierarchy';
    END IF;
    SELECT reports_to INTO current_id FROM agents WHERE id = current_id;
    depth := depth + 1;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if present, then create
DROP TRIGGER IF EXISTS trg_check_agent_hierarchy_cycle ON agents;
CREATE TRIGGER trg_check_agent_hierarchy_cycle
  BEFORE INSERT OR UPDATE OF reports_to ON agents
  FOR EACH ROW
  EXECUTE FUNCTION check_agent_hierarchy_cycle();
