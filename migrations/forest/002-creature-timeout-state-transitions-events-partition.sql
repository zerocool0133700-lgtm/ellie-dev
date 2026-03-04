-- ============================================================
-- Migration 002: Fix four architecture review findings
-- ============================================================
--
-- 1. Creature system: timeout/retry/backoff
-- 2. Seed data: duplicate git_branch='main' on Ellie Platform
-- 3. State transitions: enforce valid transition paths
-- 4. forest_events: bounded growth via partitioning + retention
--
-- Run after forest-schema.sql and forest-seed.sql.
-- ============================================================


-- ============================================================
-- FIX 1: Creature timeout / retry / backoff
-- ============================================================
-- Problem: Zombie creatures can block tree closure forever.
--          No retry on transient failures. No timeout sweep.

ALTER TABLE creatures
  ADD COLUMN timeout_seconds  INTEGER DEFAULT 300,          -- 5 min default
  ADD COLUMN timeout_at       TIMESTAMPTZ,                  -- computed on dispatch
  ADD COLUMN max_retries      INTEGER DEFAULT 2,            -- total retry attempts allowed
  ADD COLUMN retry_count      INTEGER DEFAULT 0,            -- attempts so far
  ADD COLUMN retry_after      TIMESTAMPTZ;                  -- backoff: don't retry before this

-- Auto-set timeout_at when creature is dispatched
CREATE OR REPLACE FUNCTION set_creature_timeout()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.state = 'dispatched' AND NEW.timeout_at IS NULL THEN
    NEW.timeout_at := NOW() + (NEW.timeout_seconds || ' seconds')::INTERVAL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_creature_timeout
  BEFORE INSERT OR UPDATE ON creatures
  FOR EACH ROW
  EXECUTE FUNCTION set_creature_timeout();

-- Reaper: sweep timed-out creatures → failed or retry
-- Call this on a cron (pg_cron, edge function, or app-level timer)
CREATE OR REPLACE FUNCTION reap_timed_out_creatures()
RETURNS TABLE(creature_id UUID, action TEXT) AS $$
BEGIN
  RETURN QUERY
  WITH timed_out AS (
    SELECT id, retry_count, max_retries, entity_id, tree_id, intent, instructions, type
    FROM creatures
    WHERE state IN ('dispatched', 'working')
      AND timeout_at IS NOT NULL
      AND timeout_at < NOW()
    FOR UPDATE SKIP LOCKED
  )
  -- Retry if under limit
  UPDATE creatures c
  SET
    state = CASE
      WHEN t.retry_count < t.max_retries THEN 'dispatched'
      ELSE 'failed'
    END,
    retry_count = CASE
      WHEN t.retry_count < t.max_retries THEN t.retry_count + 1
      ELSE t.retry_count
    END,
    retry_after = CASE
      WHEN t.retry_count < t.max_retries
        THEN NOW() + ((2 ^ t.retry_count) || ' minutes')::INTERVAL   -- exponential backoff
      ELSE NULL
    END,
    timeout_at = CASE
      WHEN t.retry_count < t.max_retries
        THEN NOW() + ((2 ^ t.retry_count) || ' minutes')::INTERVAL + (c.timeout_seconds || ' seconds')::INTERVAL
      ELSE NULL
    END,
    error = CASE
      WHEN t.retry_count >= t.max_retries
        THEN 'Timed out after ' || t.max_retries || ' retries'
      ELSE NULL
    END,
    completed_at = CASE
      WHEN t.retry_count >= t.max_retries THEN NOW()
      ELSE NULL
    END
  FROM timed_out t
  WHERE c.id = t.id
  RETURNING c.id AS creature_id,
    CASE WHEN c.state = 'failed' THEN 'failed_permanent' ELSE 'retrying' END AS action;
END;
$$ LANGUAGE plpgsql;

-- Index for the reaper query
CREATE INDEX idx_creatures_timeout
  ON creatures(timeout_at)
  WHERE state IN ('dispatched', 'working') AND timeout_at IS NOT NULL;


-- ============================================================
-- FIX 2: Seed data bug — duplicate git_branch='main'
-- ============================================================
-- Problem: Ellie Platform project has two trunks both with
--          git_branch='main', violating UNIQUE(tree_id, git_branch).
--
-- Fix: Use repo-qualified branch names.
-- NOTE: This is a seed data fix. If the seed has already been applied,
-- run this UPDATE. If not, fix forest-seed.sql directly.

-- Idempotent fix: only runs if the duplicate exists
DO $$
BEGIN
  UPDATE trunks
  SET git_branch = 'ellie-dev/main'
  WHERE name = 'ellie-dev'
    AND git_branch = 'main'
    AND tree_id IN (SELECT id FROM trees WHERE title = 'Ellie Platform');

  UPDATE trunks
  SET git_branch = 'ellie-home/main'
  WHERE name = 'ellie-home'
    AND git_branch = 'main'
    AND tree_id IN (SELECT id FROM trees WHERE title = 'Ellie Platform');
END $$;


-- ============================================================
-- FIX 3: State transitions aren't enforced
-- ============================================================
-- Problem: Only promote_tree() exists (nursery→seedling).
--          Nothing prevents nursery→archived or growing→nursery.

-- Valid transition map (enforced by trigger)
CREATE OR REPLACE FUNCTION enforce_tree_state_transition()
RETURNS TRIGGER AS $$
DECLARE
  valid BOOLEAN;
BEGIN
  -- Skip if state hasn't changed
  IF OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;

  -- Transition map: from → allowed destinations
  valid := CASE OLD.state
    WHEN 'nursery'   THEN NEW.state IN ('seedling', 'composted')
    WHEN 'seedling'  THEN NEW.state IN ('growing', 'dormant', 'composted')
    WHEN 'growing'   THEN NEW.state IN ('mature', 'dormant', 'archived')
    WHEN 'mature'    THEN NEW.state IN ('growing', 'dormant', 'archived')
    WHEN 'dormant'   THEN NEW.state IN ('growing', 'seedling', 'archived', 'composted')
    WHEN 'archived'  THEN NEW.state IN ('composted')
    WHEN 'composted' THEN FALSE  -- terminal state
    ELSE FALSE
  END;

  IF NOT valid THEN
    RAISE EXCEPTION 'Invalid tree state transition: % → %', OLD.state, NEW.state;
  END IF;

  -- Auto-set lifecycle timestamps
  CASE NEW.state
    WHEN 'seedling' THEN NEW.promoted_at := COALESCE(NEW.promoted_at, NOW());
    WHEN 'archived' THEN NEW.archived_at := COALESCE(NEW.archived_at, NOW()); NEW.closed_at := COALESCE(NEW.closed_at, NOW());
    WHEN 'composted' THEN NEW.closed_at := COALESCE(NEW.closed_at, NOW());
    ELSE NULL;  -- no-op
  END CASE;

  -- Emit event
  INSERT INTO forest_events (kind, tree_id, summary, data)
  VALUES ('tree.state_changed', NEW.id,
    'Tree state: ' || OLD.state || ' → ' || NEW.state,
    jsonb_build_object('from', OLD.state, 'to', NEW.state));

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_tree_state_transition
  BEFORE UPDATE OF state ON trees
  FOR EACH ROW
  EXECUTE FUNCTION enforce_tree_state_transition();

-- General-purpose transition function (replaces promote_tree)
CREATE OR REPLACE FUNCTION transition_tree(
  p_tree_id UUID,
  p_new_state tree_state
)
RETURNS VOID AS $$
BEGIN
  UPDATE trees
  SET state = p_new_state, last_activity = NOW()
  WHERE id = p_tree_id;
  -- Trigger handles validation, timestamps, and event emission
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- FIX 4: forest_events — unbounded growth
-- ============================================================
-- Problem: Append-only table with no retention, no partitioning.
--          recent_activity view has no LIMIT.

-- Option A: Time-based partitioning (requires Postgres 12+)
-- Convert forest_events to a partitioned table.
-- NOTE: This requires recreating the table. On a fresh install,
-- replace the original CREATE TABLE. For an existing install,
-- use the migration approach below.

-- Step 1: Create the partitioned replacement
CREATE TABLE forest_events_partitioned (
  id              UUID DEFAULT gen_random_uuid(),
  kind            event_kind NOT NULL,
  tree_id         UUID REFERENCES trees(id) ON DELETE SET NULL,
  entity_id       UUID REFERENCES entities(id) ON DELETE SET NULL,
  branch_id       UUID REFERENCES branches(id) ON DELETE SET NULL,
  trunk_id        UUID REFERENCES trunks(id) ON DELETE SET NULL,
  creature_id     UUID REFERENCES creatures(id) ON DELETE SET NULL,
  commit_id       UUID REFERENCES commits(id) ON DELETE SET NULL,
  summary         TEXT,
  data            JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (id, created_at)   -- partition key must be in PK
) PARTITION BY RANGE (created_at);

-- Step 2: Create partitions (current + next month + catch-all)
CREATE TABLE forest_events_2026_02 PARTITION OF forest_events_partitioned
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');

CREATE TABLE forest_events_2026_03 PARTITION OF forest_events_partitioned
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');

-- Default partition catches anything outside defined ranges
CREATE TABLE forest_events_default PARTITION OF forest_events_partitioned
  DEFAULT;

-- Step 3: Migrate existing data
INSERT INTO forest_events_partitioned
  SELECT * FROM forest_events;

-- Step 4: Swap tables
ALTER TABLE forest_events RENAME TO forest_events_old;
ALTER TABLE forest_events_partitioned RENAME TO forest_events;

-- Step 5: Recreate indexes on the partitioned table
CREATE INDEX idx_events_p_created ON forest_events(created_at DESC);
CREATE INDEX idx_events_p_kind ON forest_events(kind);
CREATE INDEX idx_events_p_tree ON forest_events(tree_id) WHERE tree_id IS NOT NULL;
CREATE INDEX idx_events_p_entity ON forest_events(entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX idx_events_p_tree_kind ON forest_events(tree_id, kind);

-- Step 6: Retention — drop old partitions instead of DELETE
-- To purge Feb data: DROP TABLE forest_events_2026_02;
-- This is instant (no row-by-row delete, no vacuum needed)

-- Retention helper: call monthly from cron/edge function
CREATE OR REPLACE FUNCTION create_next_month_partition()
RETURNS VOID AS $$
DECLARE
  next_month DATE := date_trunc('month', NOW()) + INTERVAL '2 months';
  partition_name TEXT := 'forest_events_' || to_char(next_month, 'YYYY_MM');
  start_date TEXT := to_char(next_month, 'YYYY-MM-DD');
  end_date TEXT := to_char(next_month + INTERVAL '1 month', 'YYYY-MM-DD');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF forest_events FOR VALUES FROM (%L) TO (%L)',
    partition_name, start_date, end_date
  );
END;
$$ LANGUAGE plpgsql;

-- Step 7: Fix recent_activity view — add LIMIT
DROP VIEW IF EXISTS recent_activity;
CREATE VIEW recent_activity AS
SELECT
  fe.id,
  fe.kind,
  fe.summary,
  fe.created_at,
  t.title AS tree_title,
  t.type AS tree_type,
  e.display_name AS entity_name
FROM forest_events fe
LEFT JOIN trees t ON t.id = fe.tree_id
LEFT JOIN entities e ON e.id = fe.entity_id
ORDER BY fe.created_at DESC
LIMIT 200;

-- Cleanup: drop old table after verifying migration
-- DROP TABLE forest_events_old;  -- uncomment after verification
