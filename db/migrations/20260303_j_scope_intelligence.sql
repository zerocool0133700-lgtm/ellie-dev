-- ELLIE-456: Job Tree Intelligence Layer — Phase 2 scope hierarchy
-- Adds J/2/3 (compacted history), J/4 (patterns), J/5 (governance reference).
-- All inserts are idempotent (ON CONFLICT DO NOTHING on path).

INSERT INTO knowledge_scopes (id, path, name, level, description, created_at)
VALUES

  -- ── J/2/3 Archive ─────────────────────────────────────────────────────────
  (gen_random_uuid(), 'J/2/3', 'Compacted History',         'tree',   'Rolling summaries of touchpoints older than 7 days.',           now()),

  -- ── J/4 Patterns ──────────────────────────────────────────────────────────
  (gen_random_uuid(), 'J/4',   'Patterns',                   'branch', 'Recurring behavioral observations across job runs.',             now()),
  (gen_random_uuid(), 'J/4/1', 'Execution Patterns',         'tree',   'Patterns in job execution flow and timing.',                     now()),
  (gen_random_uuid(), 'J/4/2', 'Cost Patterns',              'tree',   'Token and cost patterns across job types.',                      now()),
  (gen_random_uuid(), 'J/4/3', 'Reliability Patterns',       'tree',   'Success/failure rate patterns and retry behavior.',              now()),
  (gen_random_uuid(), 'J/4/4', 'Agent Patterns',             'tree',   'Per-agent behavioral fingerprints.',                             now()),

  -- ── J/5 Governance Reference ──────────────────────────────────────────────
  (gen_random_uuid(), 'J/5',   'Governance Reference',       'branch', 'Job governance policies: budgets, limits, rules.',               now()),
  (gen_random_uuid(), 'J/5/1', 'Budget Limits',              'tree',   'Per-execution cost limits and warning thresholds.',              now()),
  (gen_random_uuid(), 'J/5/2', 'Agent Policies',             'tree',   'Permitted models, retry caps, and agent constraints.',           now()),
  (gen_random_uuid(), 'J/5/3', 'Dispatch Rules',             'tree',   'Routing, priority, and gating rules for job dispatch.',          now())

ON CONFLICT (path) DO NOTHING;

-- Set parent_id references (requires scopes to exist first)
UPDATE knowledge_scopes c
SET    parent_id = p.id
FROM   knowledge_scopes p
WHERE  c.path IN ('J/2/3', 'J/4', 'J/4/1', 'J/4/2', 'J/4/3', 'J/4/4',
                  'J/5', 'J/5/1', 'J/5/2', 'J/5/3')
  AND  p.path = regexp_replace(c.path, '/[^/]+$', '')
  AND  c.parent_id IS NULL;
