-- ============================================================
-- MIGRATION 001: QA Gating + New Tree Types
-- ============================================================
-- Run against ellie-forest database on ellie-home
-- Prerequisites: forest-schema.sql and forest-seed.sql applied
-- ============================================================

-- 1. Add new tree types to the enum
ALTER TYPE tree_type ADD VALUE IF NOT EXISTS 'incident_response';
ALTER TYPE tree_type ADD VALUE IF NOT EXISTS 'onboarding';
ALTER TYPE tree_type ADD VALUE IF NOT EXISTS 'learning';
ALTER TYPE tree_type ADD VALUE IF NOT EXISTS 'automation';
ALTER TYPE tree_type ADD VALUE IF NOT EXISTS 'debate';
ALTER TYPE tree_type ADD VALUE IF NOT EXISTS 'deliverable';

-- 2. Add gate creature type
ALTER TYPE creature_type ADD VALUE IF NOT EXISTS 'gate';

-- 3. Add gate events
ALTER TYPE event_kind ADD VALUE IF NOT EXISTS 'gate.requested';
ALTER TYPE event_kind ADD VALUE IF NOT EXISTS 'gate.approved';
ALTER TYPE event_kind ADD VALUE IF NOT EXISTS 'gate.rejected';

-- 4. Add QA gating columns to contribution_policies
ALTER TABLE contribution_policies
  ADD COLUMN IF NOT EXISTS gate_entities UUID[] DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS gate_strategy TEXT DEFAULT NULL
    CHECK (gate_strategy IN ('all_must_approve', 'any_can_approve', 'majority'));

-- 5. Add QA entity
INSERT INTO entities (name, display_name, type, source_repo, contribution, capabilities)
VALUES ('qa_agent', 'QA Agent', 'agent', 'ellie-dev', 'many_trees',
  '["test_execution", "regression_testing", "validation", "gate_approval"]'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- 6. Update existing policies with gate info
-- Work sessions: QA gates before merge
UPDATE contribution_policies
SET gate_entities = ARRAY[(SELECT id FROM entities WHERE name = 'qa_agent')],
    gate_strategy = 'all_must_approve'
WHERE name = 'work_session_default';

-- Projects: QA + critic must both approve
UPDATE contribution_policies
SET gate_entities = ARRAY[
  (SELECT id FROM entities WHERE name = 'qa_agent'),
  (SELECT id FROM entities WHERE name = 'critic_agent')
],
    gate_strategy = 'all_must_approve'
WHERE name = 'project_default';

-- 7. Add contribution policies for new tree types
INSERT INTO contribution_policies (name, description, tree_type, max_concurrent_branches, require_approval, auto_merge, conflict_strategy, gate_strategy) VALUES
  ('incident_response_default',
   'Incident response: fast spawn, immediate promote, parallel branches. Auto-merge all findings. No gate — speed over ceremony.',
   'incident_response', 10, FALSE, TRUE, 'merge_all', NULL),

  ('onboarding_default',
   'Onboarding: template trunk, linear checkpoint branches. Auto-merge steps.',
   'onboarding', 1, FALSE, TRUE, 'last_writer_wins', NULL),

  ('learning_default',
   'Learning trees: long-lived, multi-trunk per subtopic. Auto-merge research findings.',
   'learning', 5, FALSE, TRUE, 'merge_all', NULL),

  ('automation_default',
   'Automation: recurring execution branches off template trunk. Auto-merge outputs.',
   'automation', 3, FALSE, TRUE, 'last_writer_wins', NULL),

  ('debate_default',
   'Multi-agent debate: one branch per agent, synthesis merge on trunk. Requires strategy agent gate.',
   'debate', 6, FALSE, FALSE, 'manual', 'all_must_approve'),

  ('deliverable_default',
   'Client deliverables: multi-trunk (draft/final). Final trunk gated by QA + owner approval.',
   'deliverable', 5, TRUE, FALSE, 'manual', 'all_must_approve');

-- Set gate entities for debate (strategy synthesizes)
UPDATE contribution_policies
SET gate_entities = ARRAY[(SELECT id FROM entities WHERE name = 'strategy_agent')]
WHERE name = 'debate_default';

-- Set gate entities for deliverable (QA + critic)
UPDATE contribution_policies
SET gate_entities = ARRAY[
  (SELECT id FROM entities WHERE name = 'qa_agent'),
  (SELECT id FROM entities WHERE name = 'critic_agent')
]
WHERE name = 'deliverable_default';
