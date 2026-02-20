-- ============================================================
-- FOREST ARCHITECTURE — Data Model
-- ============================================================
--
-- Three layers:
--   Entities (domain working areas) → Trees (processes) → Forest (all trees)
--
-- Core principles:
--   - Git is the storage layer; metadata lives here in the DB
--   - All trees share a common base abstraction
--   - Complex workflows = branches within one tree, not tree dependencies
--   - Forest creatures coordinate push/pull between entities and trees
--   - Trees evolve: nursery (ephemeral) → seedling → mature → archived
--   - Some trees support multiple trunks (parallel main branches)
--   - Multi-tenant by design: workspace_id isolates data per user/org
--
-- Designed for PostgreSQL (Supabase-compatible).
-- Run against a dedicated database on ellie-home.
-- Single database, no external dependencies (MongoDB dropped in refactor).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()

-- ============================================================
-- ENUMS
-- ============================================================

CREATE TYPE tree_type AS ENUM (
  'conversation',       -- Message history, agent dispatches
  'work_session',       -- Plane work items, multi-trunk capable
  'workflow',           -- Multi-step processes with dependencies
  'project',            -- Long-running dev work, milestones
  'analysis',           -- One-off deep dives, read-only after close
  'review',             -- Periodic reviews (weekly, health checks)
  'incident_response',  -- Fast lifecycle, high urgency, parallel branches
  'onboarding',         -- Template-driven, linear checkpoints
  'learning',           -- Long-lived research, dormant/reactivatable
  'automation',         -- Recurring processes, template trunk
  'debate',             -- Multi-agent synthesis, one branch per agent
  'deliverable'         -- Client-facing, gated output, draft/final trunks
);

CREATE TYPE tree_state AS ENUM (
  'nursery',         -- Ephemeral, experimental, not yet committed to forest
  'seedling',        -- Promoted to forest, young but persisted
  'growing',         -- Active, accumulating work
  'mature',          -- Stable, less frequent changes
  'dormant',         -- Paused, may resume
  'archived',        -- Closed, read-only, retained for history
  'composted'        -- Soft-deleted, can be purged
);

CREATE TYPE entity_type AS ENUM (
  'agent',           -- AI agent (dev, research, finance, etc.)
  'service',         -- System service (relay, voice, router)
  'integration',     -- External integration (calendar, github, gmail)
  'store',           -- Data store (memory, credentials)
  'interface'        -- User-facing (dashboard, extension)
);

CREATE TYPE contribution_pattern AS ENUM (
  'one_tree',        -- Specialized — contributes to a single tree at a time
  'many_trees',      -- Contributes to several trees simultaneously
  'all_trees'        -- Shared resource — available to every tree (e.g., memory)
);

CREATE TYPE branch_state AS ENUM (
  'open',            -- Active work happening
  'merging',         -- Merge in progress
  'merged',          -- Successfully merged to trunk
  'abandoned',       -- Work stopped, branch left unmerged
  'conflicted'       -- Merge conflict needs resolution
);

CREATE TYPE creature_type AS ENUM (
  'pull',            -- Tree requests entity work
  'push',            -- Entity discovers and contributes to tree
  'signal',          -- Event notification (no work, just awareness)
  'sync',            -- Bidirectional state synchronization
  'gate'             -- Gating approval — blocks merge until entity approves
);

CREATE TYPE event_kind AS ENUM (
  'tree.created',
  'tree.state_changed',
  'tree.closed',
  'trunk.created',
  'branch.created',
  'branch.merged',
  'branch.abandoned',
  'commit.added',
  'entity.attached',
  'entity.detached',
  'creature.dispatched',
  'creature.completed',
  'creature.failed',
  'gate.requested',
  'gate.approved',
  'gate.rejected'
);


-- ============================================================
-- 1. ENTITIES — Domain-specific working areas
-- ============================================================
-- Each entity maps to a capability in the system (agent, service,
-- integration, data store, or interface). Entities contribute work
-- to trees.

CREATE TABLE entities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL UNIQUE,          -- 'dev_agent', 'memory_system', 'calendar'
  display_name    TEXT NOT NULL,                 -- 'Dev Agent', 'Memory System'
  type            entity_type NOT NULL,
  source_repo     TEXT,                          -- 'ellie-dev' or 'ellie-home'
  source_path     TEXT,                          -- 'src/memory.ts', 'src/agents/dev.ts'
  contribution    contribution_pattern NOT NULL DEFAULT 'many_trees',
  capabilities    JSONB DEFAULT '[]',            -- What this entity can do
  config          JSONB DEFAULT '{}',            -- Entity-specific configuration
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_entities_type ON entities(type);
CREATE INDEX idx_entities_source_repo ON entities(source_repo);
CREATE INDEX idx_entities_active ON entities(active) WHERE active = TRUE;


-- ============================================================
-- 2. TREES — Process-driving structures
-- ============================================================
-- Every tree shares this base regardless of type. Specialized
-- behavior (conversation rules, workflow DAGs, etc.) lives in
-- the tree_config JSONB and in application code.

CREATE TABLE trees (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            tree_type NOT NULL,
  state           tree_state NOT NULL DEFAULT 'nursery',
  owner_id        TEXT,                          -- User or system that owns this tree
  title           TEXT,                          -- Human-readable name
  description     TEXT,

  -- Git backing
  git_repo_path   TEXT,                          -- Filesystem path to the git repo
  git_remote_url  TEXT,                          -- Optional remote URL

  -- Lifecycle timestamps
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  promoted_at     TIMESTAMPTZ,                   -- When moved from nursery to forest
  last_activity   TIMESTAMPTZ DEFAULT NOW(),
  closed_at       TIMESTAMPTZ,
  archived_at     TIMESTAMPTZ,

  -- Linkage to existing systems
  conversation_id UUID,                          -- Link to existing conversations table
  work_item_id    TEXT,                          -- Plane issue ID (e.g., 'ELLIE-86')
  external_ref    TEXT,                          -- Any external reference

  -- Configuration & metadata
  tree_config     JSONB DEFAULT '{}',            -- Type-specific settings
  tags            TEXT[] DEFAULT '{}',
  metadata        JSONB DEFAULT '{}'
);

CREATE INDEX idx_trees_type ON trees(type);
CREATE INDEX idx_trees_state ON trees(state);
CREATE INDEX idx_trees_state_active ON trees(state)
  WHERE state IN ('nursery', 'seedling', 'growing', 'mature');
CREATE INDEX idx_trees_owner ON trees(owner_id);
CREATE INDEX idx_trees_last_activity ON trees(last_activity DESC);
CREATE INDEX idx_trees_work_item ON trees(work_item_id) WHERE work_item_id IS NOT NULL;
CREATE INDEX idx_trees_conversation ON trees(conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX idx_trees_tags ON trees USING gin(tags);


-- ============================================================
-- 3. TRUNKS — Main branches of a tree
-- ============================================================
-- Most trees have one trunk. Multi-trunk trees (work_session,
-- project) can have several parallel main branches.

CREATE TABLE trunks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tree_id         UUID NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,                  -- 'main', 'develop', 'stable'
  git_branch      TEXT NOT NULL,                  -- Actual git branch name
  is_primary      BOOLEAN DEFAULT FALSE,          -- The default trunk for merges
  description     TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  head_commit_id  UUID,                           -- Points to latest commit (FK added after commits table)

  UNIQUE(tree_id, name),
  UNIQUE(tree_id, git_branch)
);

CREATE INDEX idx_trunks_tree ON trunks(tree_id);
CREATE INDEX idx_trunks_primary ON trunks(tree_id, is_primary) WHERE is_primary = TRUE;


-- ============================================================
-- 4. BRANCHES — Entity work within a tree
-- ============================================================
-- When an entity contributes to a tree, it works on a branch.
-- Branches merge back to a trunk when work completes.

CREATE TABLE branches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tree_id         UUID NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  trunk_id        UUID NOT NULL REFERENCES trunks(id) ON DELETE CASCADE,
  entity_id       UUID REFERENCES entities(id),  -- Which entity is doing the work
  name            TEXT NOT NULL,                  -- Branch name
  git_branch      TEXT NOT NULL,                  -- Actual git branch name
  state           branch_state NOT NULL DEFAULT 'open',
  reason          TEXT,                           -- Why this branch was created
  parent_branch_id UUID REFERENCES branches(id), -- For nested branching

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  merged_at       TIMESTAMPTZ,
  closed_at       TIMESTAMPTZ,
  head_commit_id  UUID,                           -- Latest commit on this branch
  metadata        JSONB DEFAULT '{}'
);

CREATE INDEX idx_branches_tree ON branches(tree_id);
CREATE INDEX idx_branches_trunk ON branches(trunk_id);
CREATE INDEX idx_branches_entity ON branches(entity_id);
CREATE INDEX idx_branches_state ON branches(state) WHERE state = 'open';
CREATE INDEX idx_branches_tree_state ON branches(tree_id, state);


-- ============================================================
-- 5. COMMITS — Work steps within branches/trunks
-- ============================================================
-- Each commit represents a discrete unit of work. Maps to an
-- actual git commit in the backing repo.

CREATE TABLE commits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tree_id         UUID NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  branch_id       UUID REFERENCES branches(id),  -- NULL if on trunk directly
  trunk_id        UUID REFERENCES trunks(id),     -- Which trunk (if committed to trunk)
  entity_id       UUID REFERENCES entities(id),   -- Who made this commit
  git_sha         TEXT,                           -- Actual git commit SHA
  message         TEXT NOT NULL,
  content_summary TEXT,                           -- AI-generated summary of changes
  parent_id       UUID REFERENCES commits(id),    -- Parent commit (for ordering)

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  metadata        JSONB DEFAULT '{}'
);

CREATE INDEX idx_commits_tree ON commits(tree_id);
CREATE INDEX idx_commits_branch ON commits(branch_id);
CREATE INDEX idx_commits_trunk ON commits(trunk_id);
CREATE INDEX idx_commits_entity ON commits(entity_id);
CREATE INDEX idx_commits_created ON commits(created_at DESC);
CREATE INDEX idx_commits_git_sha ON commits(git_sha) WHERE git_sha IS NOT NULL;

-- Add FK for head_commit references now that commits table exists
ALTER TABLE trunks ADD CONSTRAINT fk_trunks_head_commit
  FOREIGN KEY (head_commit_id) REFERENCES commits(id);
ALTER TABLE branches ADD CONSTRAINT fk_branches_head_commit
  FOREIGN KEY (head_commit_id) REFERENCES commits(id);


-- ============================================================
-- 6. TREE_ENTITIES — Entity-to-tree contribution mapping
-- ============================================================
-- Tracks which entities are attached to which trees, their role,
-- and contribution policy for that specific relationship.

CREATE TABLE tree_entities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tree_id         UUID NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  entity_id       UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role            TEXT DEFAULT 'contributor',     -- 'contributor', 'observer', 'owner', 'assessor', 'author', etc.
  phase           TEXT,                           -- Context/phase when role was granted (e.g., 'investigation', 'post-mortem')
  attached_at     TIMESTAMPTZ DEFAULT NOW(),
  detached_at     TIMESTAMPTZ,
  active          BOOLEAN DEFAULT TRUE,
  permissions     JSONB DEFAULT '{}',             -- What this entity can do in this tree
  metadata        JSONB DEFAULT '{}',

  UNIQUE(tree_id, entity_id)                      -- One row per entity per tree; role updated in place
);

CREATE INDEX idx_tree_entities_tree ON tree_entities(tree_id);
CREATE INDEX idx_tree_entities_entity ON tree_entities(entity_id);
CREATE INDEX idx_tree_entities_active ON tree_entities(tree_id, active) WHERE active = TRUE;


-- ============================================================
-- 7. FOREST CREATURES — Orchestration layer
-- ============================================================
-- Creatures coordinate work between entities and trees.
-- Pull: tree requests entity work. Push: entity discovers tree.
-- Each creature record is a dispatched unit of coordination.

CREATE TABLE creatures (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            creature_type NOT NULL,
  tree_id         UUID NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  entity_id       UUID NOT NULL REFERENCES entities(id),
  branch_id       UUID REFERENCES branches(id),   -- Branch created for this work (if any)
  parent_creature_id UUID REFERENCES creatures(id), -- Chain link: which creature spawned this one

  -- What triggered this creature
  trigger_event   TEXT,                            -- Event that spawned this creature
  trigger_data    JSONB DEFAULT '{}',

  -- Work description
  intent          TEXT NOT NULL,                   -- What the creature needs to accomplish
  instructions    JSONB DEFAULT '{}',              -- Detailed instructions for the entity

  -- Lifecycle
  state           TEXT NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending', 'dispatched', 'working', 'completed', 'failed', 'cancelled')),
  dispatched_at   TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,

  -- Timeout & retry
  timeout_seconds INTEGER DEFAULT 300,             -- Default 5 min; NULL = no timeout
  timeout_at      TIMESTAMPTZ,                     -- Auto-set on dispatch: dispatched_at + timeout_seconds
  max_retries     INTEGER DEFAULT 3,
  retry_count     INTEGER DEFAULT 0,
  retry_after     TIMESTAMPTZ,                     -- Exponential backoff: next eligible retry time

  -- Result
  result          JSONB,                           -- What the entity produced
  error           TEXT,                            -- If failed, why

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  metadata        JSONB DEFAULT '{}'
);

CREATE INDEX idx_creatures_tree ON creatures(tree_id);
CREATE INDEX idx_creatures_entity ON creatures(entity_id);
CREATE INDEX idx_creatures_state ON creatures(state) WHERE state NOT IN ('completed', 'failed', 'cancelled');
CREATE INDEX idx_creatures_type ON creatures(type);
CREATE INDEX idx_creatures_branch ON creatures(branch_id) WHERE branch_id IS NOT NULL;
CREATE INDEX idx_creatures_parent ON creatures(parent_creature_id) WHERE parent_creature_id IS NOT NULL;


-- ============================================================
-- 8. FOREST EVENTS — Observability
-- ============================================================
-- Every significant action in the forest emits an event.
-- Powers monitoring, triggers, real-time UI, and replay.

-- Partitioned by month for bounded growth. Drop old partitions to reclaim space instantly.
CREATE TABLE forest_events (
  id              UUID DEFAULT gen_random_uuid(),
  kind            event_kind NOT NULL,
  tree_id         UUID,                            -- No FK on partitioned tables (Postgres limitation)
  entity_id       UUID,
  branch_id       UUID,
  trunk_id        UUID,
  creature_id     UUID,
  commit_id       UUID,

  summary         TEXT,                            -- Human-readable description
  data            JSONB DEFAULT '{}',              -- Event-specific payload

  created_at      TIMESTAMPTZ DEFAULT NOW(),

  PRIMARY KEY (id, created_at)                     -- Partition key must be in PK
) PARTITION BY RANGE (created_at);

-- Create initial partitions (add more via create_monthly_partition())
CREATE TABLE forest_events_2026_02 PARTITION OF forest_events
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE forest_events_2026_03 PARTITION OF forest_events
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');

-- Indexes (created on parent, inherited by partitions)
CREATE INDEX idx_events_created ON forest_events(created_at DESC);
CREATE INDEX idx_events_kind ON forest_events(kind);
CREATE INDEX idx_events_tree ON forest_events(tree_id) WHERE tree_id IS NOT NULL;
CREATE INDEX idx_events_entity ON forest_events(entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX idx_events_tree_kind ON forest_events(tree_id, kind);


-- ============================================================
-- 9. CONTRIBUTION POLICIES — Rules for entity participation
-- ============================================================
-- Defines which entities can contribute to which tree types,
-- under what conditions, and how conflicts are resolved.

CREATE TABLE contribution_policies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL UNIQUE,
  description     TEXT,

  -- Scope: which trees does this policy apply to?
  tree_type       tree_type,                       -- NULL = applies to all types
  tree_id         UUID REFERENCES trees(id),       -- NULL = applies to type broadly

  -- Rules
  allowed_entities UUID[],                         -- NULL = any entity can contribute
  max_concurrent_branches INTEGER DEFAULT 5,       -- Per entity, per tree
  require_approval BOOLEAN DEFAULT FALSE,          -- Must a creature be approved before work?
  auto_merge      BOOLEAN DEFAULT TRUE,            -- Auto-merge on completion?
  conflict_strategy TEXT DEFAULT 'last_writer_wins'
                  CHECK (conflict_strategy IN ('last_writer_wins', 'manual', 'merge_all', 'priority')),

  -- QA Gating
  gate_entities   UUID[],                          -- Entities that must approve before trunk merge
  gate_strategy   TEXT DEFAULT NULL                 -- How gate approval works
                  CHECK (gate_strategy IN ('all_must_approve', 'any_can_approve', 'majority')),

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  metadata        JSONB DEFAULT '{}'
);

CREATE INDEX idx_policies_tree_type ON contribution_policies(tree_type);


-- ============================================================
-- 10. SEED DATA — Initial entities from ellie-dev & ellie-home
-- ============================================================

INSERT INTO entities (name, display_name, type, source_repo, source_path, contribution) VALUES
  -- ellie-dev entities
  ('memory_system',   'Memory System',     'store',       'ellie-dev',  'src/memory.ts',          'all_trees'),
  ('dev_agent',       'Dev Agent',         'agent',       'ellie-dev',  'src/agents/dev',         'one_tree'),
  ('research_agent',  'Research Agent',    'agent',       'ellie-dev',  'src/agents/research',    'many_trees'),
  ('finance_agent',   'Finance Agent',     'agent',       'ellie-dev',  'src/agents/finance',     'one_tree'),
  ('strategy_agent',  'Strategy Agent',    'agent',       'ellie-dev',  'src/agents/strategy',    'many_trees'),
  ('content_agent',   'Content Agent',     'agent',       'ellie-dev',  'src/agents/content',     'one_tree'),
  ('critic_agent',    'Critic Agent',      'agent',       'ellie-dev',  'src/agents/critic',      'many_trees'),
  ('general_agent',   'General Agent',     'agent',       'ellie-dev',  'src/agents/general',     'all_trees'),
  ('relay_bot',       'Relay Bot',         'service',     'ellie-dev',  'src/relay.ts',           'all_trees'),
  ('voice_system',    'Voice System',      'service',     'ellie-dev',  'src/transcribe.ts',      'many_trees'),
  ('agent_router',    'Agent Router',      'service',     'ellie-dev',  'src/agent-router.ts',    'all_trees'),
  ('work_sessions',   'Work Sessions',     'service',     'ellie-dev',  'src/api/work-session.ts','many_trees'),
  -- ellie-home entities
  ('dashboard_ui',    'Dashboard UI',      'interface',   'ellie-home', 'src/app',                'many_trees'),
  ('execution_plans', 'Execution Plans',   'service',     'ellie-home', 'src/lib/execution',      'many_trees'),
  ('calendar_int',    'Calendar',          'integration', 'ellie-home', NULL,                     'many_trees'),
  ('github_int',      'GitHub',            'integration', 'ellie-home', NULL,                     'many_trees'),
  ('gmail_int',       'Gmail',             'integration', 'ellie-home', NULL,                     'many_trees');


-- ============================================================
-- HELPER VIEWS
-- ============================================================

-- Active forest: all non-archived, non-composted trees
CREATE VIEW forest AS
SELECT
  t.*,
  count(DISTINCT te.entity_id) FILTER (WHERE te.active) AS entity_count,
  count(DISTINCT b.id) FILTER (WHERE b.state = 'open') AS open_branches,
  count(DISTINCT tr.id) AS trunk_count
FROM trees t
LEFT JOIN tree_entities te ON te.tree_id = t.id
LEFT JOIN branches b ON b.tree_id = t.id
LEFT JOIN trunks tr ON tr.tree_id = t.id
WHERE t.state NOT IN ('archived', 'composted')
GROUP BY t.id;

-- Entity workload: how busy is each entity across the forest
CREATE VIEW entity_workload AS
SELECT
  e.*,
  count(DISTINCT te.tree_id) FILTER (WHERE te.active) AS active_trees,
  count(DISTINCT b.id) FILTER (WHERE b.state = 'open') AS open_branches,
  count(DISTINCT c.id) FILTER (WHERE c.state IN ('pending', 'dispatched', 'working')) AS pending_creatures
FROM entities e
LEFT JOIN tree_entities te ON te.entity_id = e.id
LEFT JOIN branches b ON b.entity_id = e.id
LEFT JOIN creatures c ON c.entity_id = e.id
WHERE e.active = TRUE
GROUP BY e.id;

-- Recent forest activity (bounded to 200 rows)
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


-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

-- Create a new tree with its primary trunk
CREATE OR REPLACE FUNCTION create_tree(
  p_type tree_type,
  p_title TEXT,
  p_owner_id TEXT DEFAULT NULL,
  p_state tree_state DEFAULT 'nursery',
  p_trunk_name TEXT DEFAULT 'main'
)
RETURNS UUID AS $$
DECLARE
  v_tree_id UUID;
BEGIN
  INSERT INTO trees (type, state, owner_id, title)
  VALUES (p_type, p_state, p_owner_id, p_title)
  RETURNING id INTO v_tree_id;

  INSERT INTO trunks (tree_id, name, git_branch, is_primary)
  VALUES (v_tree_id, p_trunk_name, p_trunk_name, TRUE);

  INSERT INTO forest_events (kind, tree_id, summary)
  VALUES ('tree.created', v_tree_id, 'Tree created: ' || p_title);

  RETURN v_tree_id;
END;
$$ LANGUAGE plpgsql;

-- Transition a tree to a new state (with enforced transition rules)
CREATE OR REPLACE FUNCTION transition_tree(
  p_tree_id UUID,
  p_target_state tree_state
)
RETURNS VOID AS $$
DECLARE
  v_current_state tree_state;
BEGIN
  SELECT state INTO v_current_state FROM trees WHERE id = p_tree_id FOR UPDATE;

  -- The trigger on trees enforces valid transitions — just do the update
  UPDATE trees SET state = p_target_state WHERE id = p_tree_id;
END;
$$ LANGUAGE plpgsql;

-- Dispatch a creature (coordinate entity ↔ tree work)
CREATE OR REPLACE FUNCTION dispatch_creature(
  p_type creature_type,
  p_tree_id UUID,
  p_entity_id UUID,
  p_intent TEXT,
  p_instructions JSONB DEFAULT '{}'
)
RETURNS UUID AS $$
DECLARE
  v_creature_id UUID;
BEGIN
  INSERT INTO creatures (type, tree_id, entity_id, intent, instructions, state, dispatched_at)
  VALUES (p_type, p_tree_id, p_entity_id, p_intent, p_instructions, 'dispatched', NOW())
  RETURNING id INTO v_creature_id;

  -- Auto-attach entity to tree if not already
  INSERT INTO tree_entities (tree_id, entity_id, role)
  VALUES (p_tree_id, p_entity_id, 'contributor')
  ON CONFLICT (tree_id, entity_id) DO UPDATE SET active = TRUE;

  INSERT INTO forest_events (kind, tree_id, entity_id, creature_id, summary)
  VALUES ('creature.dispatched', p_tree_id, p_entity_id, v_creature_id,
          'Creature dispatched: ' || p_intent);

  RETURN v_creature_id;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- TRIGGERS — State Transition Enforcement
-- ============================================================
-- Valid transitions:
--   nursery  → seedling | composted
--   seedling → growing | dormant | composted
--   growing  → mature | dormant | archived
--   mature   → growing | dormant | archived
--   dormant  → growing | seedling | archived | composted
--   archived → composted
--   composted → (terminal — no transitions out)

CREATE OR REPLACE FUNCTION enforce_tree_state_transition()
RETURNS TRIGGER AS $$
DECLARE
  v_valid BOOLEAN;
BEGIN
  IF OLD.state = NEW.state THEN
    RETURN NEW;  -- No-op, allow
  END IF;

  v_valid := CASE OLD.state::text
    WHEN 'nursery'   THEN NEW.state IN ('seedling', 'composted')
    WHEN 'seedling'  THEN NEW.state IN ('growing', 'dormant', 'composted')
    WHEN 'growing'   THEN NEW.state IN ('mature', 'dormant', 'archived')
    WHEN 'mature'    THEN NEW.state IN ('growing', 'dormant', 'archived')
    WHEN 'dormant'   THEN NEW.state IN ('growing', 'seedling', 'archived', 'composted')
    WHEN 'archived'  THEN NEW.state IN ('composted')
    WHEN 'composted' THEN FALSE  -- terminal
    ELSE FALSE
  END;

  IF NOT v_valid THEN
    RAISE EXCEPTION 'Invalid tree state transition: % → %', OLD.state, NEW.state;
  END IF;

  -- Auto-set lifecycle timestamps
  IF NEW.state = 'seedling' AND OLD.state = 'nursery' THEN
    NEW.promoted_at := COALESCE(NEW.promoted_at, NOW());
  END IF;
  IF NEW.state = 'archived' THEN
    NEW.archived_at := COALESCE(NEW.archived_at, NOW());
  END IF;
  IF NEW.state IN ('archived', 'composted') THEN
    NEW.closed_at := COALESCE(NEW.closed_at, NOW());
  END IF;

  -- Emit state change event
  INSERT INTO forest_events (kind, tree_id, summary, data)
  VALUES ('tree.state_changed', NEW.id,
          'Tree state: ' || OLD.state || ' → ' || NEW.state,
          jsonb_build_object('from', OLD.state::text, 'to', NEW.state::text));

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_tree_state
  BEFORE UPDATE OF state ON trees
  FOR EACH ROW
  EXECUTE FUNCTION enforce_tree_state_transition();


-- ============================================================
-- TRIGGERS — Creature Timeout Auto-Set
-- ============================================================
-- When a creature is dispatched, auto-compute timeout_at from timeout_seconds.

CREATE OR REPLACE FUNCTION set_creature_timeout()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.state = 'dispatched' AND NEW.timeout_seconds IS NOT NULL THEN
    NEW.timeout_at := COALESCE(NEW.dispatched_at, NOW()) + (NEW.timeout_seconds || ' seconds')::INTERVAL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_creature_timeout
  BEFORE INSERT OR UPDATE OF state ON creatures
  FOR EACH ROW
  EXECUTE FUNCTION set_creature_timeout();


-- ============================================================
-- Creature Reaper — Timeout & Retry with Exponential Backoff
-- ============================================================
-- Call on a cron (e.g., every 30s). Retries with backoff up to max_retries,
-- then marks failed. Uses SKIP LOCKED so concurrent reapers don't fight.

CREATE OR REPLACE FUNCTION reap_timed_out_creatures()
RETURNS TABLE(creature_id UUID, action TEXT) AS $$
BEGIN
  RETURN QUERY
  WITH timed_out AS (
    SELECT c.id
    FROM creatures c
    WHERE c.state IN ('dispatched', 'working')
      AND c.timeout_at IS NOT NULL
      AND c.timeout_at < NOW()
    FOR UPDATE SKIP LOCKED
  ),
  retried AS (
    UPDATE creatures c
    SET
      state = 'dispatched',
      retry_count = c.retry_count + 1,
      dispatched_at = NOW(),
      timeout_at = NOW() + ((c.timeout_seconds * power(2, c.retry_count)) || ' seconds')::INTERVAL,
      retry_after = NOW() + ((c.timeout_seconds * power(2, c.retry_count)) || ' seconds')::INTERVAL,
      error = 'Timeout after ' || c.timeout_seconds || 's (retry ' || (c.retry_count + 1) || '/' || c.max_retries || ')'
    FROM timed_out t
    WHERE c.id = t.id
      AND c.retry_count < c.max_retries
    RETURNING c.id, 'retried'::TEXT AS action
  ),
  failed AS (
    UPDATE creatures c
    SET
      state = 'failed',
      completed_at = NOW(),
      error = 'Timed out after ' || c.max_retries || ' retries'
    FROM timed_out t
    WHERE c.id = t.id
      AND c.retry_count >= c.max_retries
    RETURNING c.id, 'failed'::TEXT AS action
  )
  SELECT * FROM retried
  UNION ALL
  SELECT * FROM failed;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- Partition Helper — Create next month's event partition
-- ============================================================
-- Call monthly via cron. Idempotent (IF NOT EXISTS).

CREATE OR REPLACE FUNCTION create_monthly_partition(p_year INTEGER, p_month INTEGER)
RETURNS VOID AS $$
DECLARE
  v_start DATE := make_date(p_year, p_month, 1);
  v_end   DATE := v_start + INTERVAL '1 month';
  v_name  TEXT := format('forest_events_%s_%s', p_year, lpad(p_month::TEXT, 2, '0'));
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF forest_events FOR VALUES FROM (%L) TO (%L)',
    v_name, v_start, v_end
  );
END;
$$ LANGUAGE plpgsql;
