-- ELLIE-455: Job Tree (J Scope) Foundation
-- Registers the J (Jobs / The Workshop) scope hierarchy in knowledge_scopes.
-- Touchpoints written by writeJobTouchpoint() target these scope paths.
-- All inserts are idempotent (ON CONFLICT DO NOTHING on path).

INSERT INTO knowledge_scopes (id, path, name, level, description, created_at)
VALUES

  -- ── Root ──────────────────────────────────────────────────────────────────
  (gen_random_uuid(), 'J',     'Jobs — The Workshop',           'world',  'Job execution scope root. All job lifecycle data lives here.',   now()),

  -- ── J/1 Definitions ───────────────────────────────────────────────────────
  (gen_random_uuid(), 'J/1',   'Definitions',                   'branch', 'Job type documentation. Reference scope, not auto-populated.',   now()),

  -- ── J/2 Execution ─────────────────────────────────────────────────────────
  (gen_random_uuid(), 'J/2',   'Execution',                     'branch', 'Active and recent job state.',                                   now()),
  (gen_random_uuid(), 'J/2/1', 'Active',                        'tree',   'Currently running jobs.',                                        now()),
  (gen_random_uuid(), 'J/2/2', 'Recent',                        'tree',   'Jobs completed or failed in the last 24h.',                      now()),

  -- ── J/3 Creature Trails ───────────────────────────────────────────────────
  (gen_random_uuid(), 'J/3',   'Creature Trails',               'branch', 'Per-entity execution breadcrumbs. One sub-scope per agent type.', now()),
  (gen_random_uuid(), 'J/3/1', 'Dev Agent Trails',              'tree',   'Breadcrumbs left by dev / dev-ant agents.',                      now()),
  (gen_random_uuid(), 'J/3/2', 'Strategy Agent Trails',         'tree',   'Breadcrumbs left by strategy agents.',                           now()),
  (gen_random_uuid(), 'J/3/3', 'Research Agent Trails',         'tree',   'Breadcrumbs left by research agents.',                           now()),
  (gen_random_uuid(), 'J/3/4', 'Content Agent Trails',          'tree',   'Breadcrumbs left by content agents.',                            now()),
  (gen_random_uuid(), 'J/3/5', 'Finance Agent Trails',          'tree',   'Breadcrumbs left by finance agents.',                            now()),
  (gen_random_uuid(), 'J/3/6', 'Critic Agent Trails',           'tree',   'Breadcrumbs left by critic agents.',                             now()),
  (gen_random_uuid(), 'J/3/7', 'General Agent Trails',          'tree',   'Breadcrumbs left by general / ellie-chat agents.',               now())

ON CONFLICT (path) DO NOTHING;

-- Set parent_id references (requires scopes to exist first)
UPDATE knowledge_scopes c
SET    parent_id = p.id
FROM   knowledge_scopes p
WHERE  c.path LIKE 'J/%'
  AND  p.path = regexp_replace(c.path, '/[^/]+$', '')
  AND  c.parent_id IS NULL;

-- Root J scope has no parent (intentionally)
