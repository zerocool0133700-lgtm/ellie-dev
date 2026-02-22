-- ============================================================
-- FOREST SEED DATA
-- ============================================================
-- Populates the forest with the current state of the Ellie system.
-- Run after forest-schema.sql has been applied.
--
-- Entities are already seeded by the schema. This adds:
--   - Contribution policies (rules of the forest)
--   - Trees (active processes in the system)
--   - Trunks (main branches of each tree)
--   - Tree-entity mappings (who contributes where)
--   - Sample creatures (orchestration in action)
--   - Forest events (initial history)
-- ============================================================

-- ============================================================
-- 1. CONTRIBUTION POLICIES — Rules of the forest
-- ============================================================

INSERT INTO contribution_policies (name, description, tree_type, max_concurrent_branches, require_approval, auto_merge, conflict_strategy) VALUES
  -- Global defaults per tree type
  ('conversation_default',
   'Conversations auto-merge agent work. Linear trunk, agent branches merge on completion.',
   'conversation', 3, FALSE, TRUE, 'last_writer_wins'),

  ('work_session_default',
   'Work sessions support multi-trunk. Dev agent gets primary access. Critic reviews before merge.',
   'work_session', 5, FALSE, TRUE, 'last_writer_wins'),

  ('workflow_default',
   'Workflows have dependency ordering. Branches may wait on other branches to complete.',
   'workflow', 10, FALSE, TRUE, 'merge_all'),

  ('project_default',
   'Long-running projects. Multiple trunks (main/develop). Tagged milestones. Manual merge for large changes.',
   'project', 10, FALSE, FALSE, 'manual'),

  ('analysis_default',
   'Analysis trees are read-only after completion. Auto-archive. Optimized for replay.',
   'analysis', 3, FALSE, TRUE, 'last_writer_wins'),

  ('review_default',
   'Reviews are periodic. Single trunk, multiple agent branches for different perspectives.',
   'review', 6, FALSE, TRUE, 'merge_all');


-- ============================================================
-- 2. TREES — Active processes in the forest
-- ============================================================

-- Helper: grab entity IDs for use in later inserts
DO $$
DECLARE
  -- Entity references
  e_memory      UUID := (SELECT id FROM entities WHERE name = 'memory_system');
  e_dev         UUID := (SELECT id FROM entities WHERE name = 'dev_agent');
  e_research    UUID := (SELECT id FROM entities WHERE name = 'research_agent');
  e_finance     UUID := (SELECT id FROM entities WHERE name = 'finance_agent');
  e_strategy    UUID := (SELECT id FROM entities WHERE name = 'strategy_agent');
  e_content     UUID := (SELECT id FROM entities WHERE name = 'content_agent');
  e_critic      UUID := (SELECT id FROM entities WHERE name = 'critic_agent');
  e_general     UUID := (SELECT id FROM entities WHERE name = 'general_agent');
  e_relay       UUID := (SELECT id FROM entities WHERE name = 'relay_bot');
  e_voice       UUID := (SELECT id FROM entities WHERE name = 'voice_system');
  e_router      UUID := (SELECT id FROM entities WHERE name = 'agent_router');
  e_worksess    UUID := (SELECT id FROM entities WHERE name = 'work_sessions');
  e_dashboard   UUID := (SELECT id FROM entities WHERE name = 'dashboard_ui');
  e_execplans   UUID := (SELECT id FROM entities WHERE name = 'execution_plans');
  e_calendar    UUID := (SELECT id FROM entities WHERE name = 'calendar_int');
  e_github      UUID := (SELECT id FROM entities WHERE name = 'github_int');
  e_gmail       UUID := (SELECT id FROM entities WHERE name = 'gmail_int');

  -- Tree IDs (pre-generated for referencing)
  t_gchat_conv  UUID := gen_random_uuid();
  t_tg_conv     UUID := gen_random_uuid();
  t_forest_proj UUID := gen_random_uuid();
  t_ellie_proj  UUID := gen_random_uuid();
  t_ws_83       UUID := gen_random_uuid();
  t_ws_73       UUID := gen_random_uuid();
  t_ws_86       UUID := gen_random_uuid();
  t_ws_85       UUID := gen_random_uuid();
  t_ws_84       UUID := gen_random_uuid();
  t_mem_review  UUID := gen_random_uuid();
  t_email_wf    UUID := gen_random_uuid();

  -- Trunk IDs
  tr_id UUID;
BEGIN

  -- --------------------------------------------------------
  -- CONVERSATION TREES — Active messaging threads
  -- --------------------------------------------------------

  INSERT INTO trees (id, type, state, owner_id, title, description, work_item_id, tags)
  VALUES (t_gchat_conv, 'conversation', 'growing', 'dave',
    'Google Chat — Primary',
    'Dave''s primary Google Chat conversation thread. Forest architecture design discussions.',
    NULL,
    ARRAY['gchat', 'active', 'primary']);

  INSERT INTO trunks (tree_id, name, git_branch, is_primary, description)
  VALUES (t_gchat_conv, 'main', 'main', TRUE, 'Linear message timeline');

  INSERT INTO trees (id, type, state, owner_id, title, description, tags)
  VALUES (t_tg_conv, 'conversation', 'growing', 'dave',
    'Telegram — Primary',
    'Dave''s primary Telegram conversation thread. Day-to-day operations and quick interactions.',
    ARRAY['telegram', 'active', 'primary']);

  INSERT INTO trunks (tree_id, name, git_branch, is_primary, description)
  VALUES (t_tg_conv, 'main', 'main', TRUE, 'Linear message timeline');


  -- --------------------------------------------------------
  -- PROJECT TREES — Long-running development efforts
  -- --------------------------------------------------------

  INSERT INTO trees (id, type, state, owner_id, title, description, tags)
  VALUES (t_forest_proj, 'project', 'seedling', 'dave',
    'Forest Architecture',
    'The tree/forest architecture itself — designing and implementing the git-based agent interaction model. Three layers: Entities, Trees, Forest.',
    ARRAY['architecture', 'meta', 'foundation']);

  -- Multi-trunk: design + implementation
  INSERT INTO trunks (tree_id, name, git_branch, is_primary, description) VALUES
    (t_forest_proj, 'main', 'main', TRUE, 'Stable design decisions and schema'),
    (t_forest_proj, 'develop', 'develop', FALSE, 'Active implementation work');

  INSERT INTO trees (id, type, state, owner_id, title, description, tags)
  VALUES (t_ellie_proj, 'project', 'mature', 'dave',
    'Ellie Platform',
    'The overarching Ellie personal AI assistant project. Encompasses relay, agents, memory, integrations, dashboard.',
    ARRAY['platform', 'core', 'long-running']);

  -- Multi-trunk: ellie-dev + ellie-home (unique git_branch per tree)
  INSERT INTO trunks (tree_id, name, git_branch, is_primary, description) VALUES
    (t_ellie_proj, 'ellie-dev', 'ellie-dev/main', TRUE, 'Backend: relay, agents, memory, voice'),
    (t_ellie_proj, 'ellie-home', 'ellie-home/main', FALSE, 'Frontend: dashboard, execution plans, UI');


  -- --------------------------------------------------------
  -- WORK SESSION TREES — Active Plane tickets
  -- --------------------------------------------------------

  INSERT INTO trees (id, type, state, owner_id, title, description, work_item_id, tags)
  VALUES (t_ws_83, 'work_session', 'growing', 'dave',
    '[ELLIE-83] Fix GChat respondedSync crash',
    'Fix GChat respondedSync crash + humanize exit 143 errors. Urgent priority.',
    'ELLIE-83',
    ARRAY['bugfix', 'urgent', 'gchat']);

  INSERT INTO trunks (tree_id, name, git_branch, is_primary, description)
  VALUES (t_ws_83, 'main', 'main', TRUE, 'Fix implementation');

  INSERT INTO trees (id, type, state, owner_id, title, description, work_item_id, tags)
  VALUES (t_ws_73, 'work_session', 'growing', 'dave',
    '[ELLIE-73] Investigate SIGTERM exits',
    'Investigate SIGTERM exits in dev agent processes. Medium priority.',
    'ELLIE-73',
    ARRAY['investigation', 'stability']);

  INSERT INTO trunks (tree_id, name, git_branch, is_primary, description)
  VALUES (t_ws_73, 'main', 'main', TRUE, 'Investigation and fix');

  INSERT INTO trees (id, type, state, owner_id, title, description, work_item_id, tags)
  VALUES (t_ws_86, 'work_session', 'nursery', 'dave',
    '[ELLIE-86] Unified Email: Outlook + Hotmail',
    'Microsoft Graph API integration for Outlook and Hotmail email. High priority, not yet started.',
    'ELLIE-86',
    ARRAY['integration', 'email', 'microsoft']);

  INSERT INTO trunks (tree_id, name, git_branch, is_primary, description)
  VALUES (t_ws_86, 'main', 'main', TRUE, 'Implementation');

  INSERT INTO trees (id, type, state, owner_id, title, description, work_item_id, tags)
  VALUES (t_ws_85, 'work_session', 'nursery', 'dave',
    '[ELLIE-85] Repair Feb 19 data quality',
    'Fix data quality issues from pre-fix bugs on Feb 19. Medium priority.',
    'ELLIE-85',
    ARRAY['data-quality', 'repair']);

  INSERT INTO trunks (tree_id, name, git_branch, is_primary, description)
  VALUES (t_ws_85, 'main', 'main', TRUE, 'Data repair');

  INSERT INTO trees (id, type, state, owner_id, title, description, work_item_id, tags)
  VALUES (t_ws_84, 'work_session', 'nursery', 'dave',
    '[ELLIE-84] Dispatch confirmation messages',
    'Add dispatch confirmation messages across all channels. Medium priority.',
    'ELLIE-84',
    ARRAY['ux', 'notifications']);

  INSERT INTO trunks (tree_id, name, git_branch, is_primary, description)
  VALUES (t_ws_84, 'main', 'main', TRUE, 'Implementation');


  -- --------------------------------------------------------
  -- REVIEW TREES — Periodic processes
  -- --------------------------------------------------------

  INSERT INTO trees (id, type, state, owner_id, title, description, tags)
  VALUES (t_mem_review, 'review', 'seedling', 'dave',
    'Memory Quality Review',
    'Periodic review of shared memory quality — dedup, attribution gaps, stale entries. Runs as needed.',
    ARRAY['memory', 'quality', 'periodic']);

  INSERT INTO trunks (tree_id, name, git_branch, is_primary, description)
  VALUES (t_mem_review, 'main', 'main', TRUE, 'Review findings and actions');


  -- --------------------------------------------------------
  -- WORKFLOW TREES — Multi-step processes
  -- --------------------------------------------------------

  INSERT INTO trees (id, type, state, owner_id, title, description, work_item_id, tags)
  VALUES (t_email_wf, 'workflow', 'nursery', 'dave',
    'Email Unification Workflow',
    'Multi-step workflow: Gmail (existing) + Outlook/Hotmail (ELLIE-86) → unified email entity. Depends on Microsoft Graph integration.',
    'ELLIE-86',
    ARRAY['email', 'unification', 'multi-step']);

  INSERT INTO trunks (tree_id, name, git_branch, is_primary, description)
  VALUES (t_email_wf, 'main', 'main', TRUE, 'Workflow execution');


  -- ============================================================
  -- 3. TREE-ENTITY MAPPINGS — Who contributes where
  -- ============================================================

  -- Conversation trees: relay, router, memory, all agents
  INSERT INTO tree_entities (tree_id, entity_id, role) VALUES
    -- GChat conversation
    (t_gchat_conv, e_relay,    'owner'),
    (t_gchat_conv, e_router,   'contributor'),
    (t_gchat_conv, e_memory,   'contributor'),
    (t_gchat_conv, e_general,  'contributor'),
    (t_gchat_conv, e_dev,      'contributor'),
    (t_gchat_conv, e_research, 'contributor'),
    (t_gchat_conv, e_strategy, 'contributor'),
    -- Telegram conversation
    (t_tg_conv, e_relay,    'owner'),
    (t_tg_conv, e_router,   'contributor'),
    (t_tg_conv, e_memory,   'contributor'),
    (t_tg_conv, e_general,  'contributor'),
    (t_tg_conv, e_dev,      'contributor'),
    (t_tg_conv, e_research, 'contributor'),
    (t_tg_conv, e_voice,    'contributor');

  -- Forest architecture project
  INSERT INTO tree_entities (tree_id, entity_id, role) VALUES
    (t_forest_proj, e_dev,      'contributor'),
    (t_forest_proj, e_research, 'contributor'),
    (t_forest_proj, e_strategy, 'contributor'),
    (t_forest_proj, e_critic,   'observer'),
    (t_forest_proj, e_memory,   'contributor'),
    (t_forest_proj, e_dashboard,'observer');

  -- Ellie platform project — everything touches it
  INSERT INTO tree_entities (tree_id, entity_id, role) VALUES
    (t_ellie_proj, e_dev,       'contributor'),
    (t_ellie_proj, e_relay,     'contributor'),
    (t_ellie_proj, e_memory,    'contributor'),
    (t_ellie_proj, e_router,    'contributor'),
    (t_ellie_proj, e_voice,     'contributor'),
    (t_ellie_proj, e_worksess,  'contributor'),
    (t_ellie_proj, e_dashboard, 'contributor'),
    (t_ellie_proj, e_execplans, 'contributor'),
    (t_ellie_proj, e_github,    'contributor'),
    (t_ellie_proj, e_gmail,     'contributor'),
    (t_ellie_proj, e_calendar,  'contributor');

  -- Work session trees
  INSERT INTO tree_entities (tree_id, entity_id, role) VALUES
    -- ELLIE-83: GChat crash fix
    (t_ws_83, e_dev,     'contributor'),
    (t_ws_83, e_relay,   'contributor'),
    (t_ws_83, e_critic,  'observer'),
    (t_ws_83, e_memory,  'contributor'),
    -- ELLIE-73: SIGTERM investigation
    (t_ws_73, e_dev,     'contributor'),
    (t_ws_73, e_research,'contributor'),
    (t_ws_73, e_memory,  'contributor'),
    -- ELLIE-86: Email unification
    (t_ws_86, e_dev,     'contributor'),
    (t_ws_86, e_research,'contributor'),
    (t_ws_86, e_gmail,   'contributor');

  -- Memory review
  INSERT INTO tree_entities (tree_id, entity_id, role) VALUES
    (t_mem_review, e_memory,   'owner'),
    (t_mem_review, e_critic,   'contributor'),
    (t_mem_review, e_research, 'contributor');


  -- ============================================================
  -- 4. SAMPLE CREATURES — Orchestration in action
  -- ============================================================

  -- Pull: conversation tree dispatches dev agent for code work
  INSERT INTO creatures (type, tree_id, entity_id, intent, instructions, state, dispatched_at, started_at, completed_at, result)
  VALUES ('pull', t_gchat_conv, e_dev,
    'Create forest-schema.sql for the tree/forest architecture',
    '{"task": "Design and create the SQL schema for the forest architecture", "context": "Dave wants git-backed trees with entities, branches, trunks, creatures"}'::jsonb,
    'completed', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour',
    '{"output": "Schema created at docs/architecture/forest-schema.sql with 10 tables, 3 views, 3 functions"}'::jsonb);

  -- Pull: conversation tree dispatches strategy agent for architecture thinking
  INSERT INTO creatures (type, tree_id, entity_id, intent, instructions, state, dispatched_at, started_at, completed_at, result)
  VALUES ('pull', t_gchat_conv, e_strategy,
    'Analyze tree taxonomy and base abstraction design',
    '{"task": "Think through tree types, base invariants, lifecycle management", "context": "Dave wants all trees to share a common base with specialized behavior layered on top"}'::jsonb,
    'completed', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '2 hours',
    '{"output": "Defined 6 tree types, base abstraction with 6 components, lifecycle enum with 7 stages"}'::jsonb);

  -- Push: memory entity proactively contributes to forest project
  INSERT INTO creatures (type, tree_id, entity_id, intent, state, dispatched_at, started_at, completed_at, result)
  VALUES ('push', t_forest_proj, e_memory,
    'Store forest architecture design decisions as persistent memories',
    'completed', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '30 minutes',
    '{"memories_stored": 12, "topics": ["tree_types", "entity_model", "git_storage", "lifecycle", "multi_trunk"]}'::jsonb);

  -- Signal: relay notifies about high conversation volume
  INSERT INTO creatures (type, tree_id, entity_id, intent, state, dispatched_at, completed_at)
  VALUES ('signal', t_gchat_conv, e_relay,
    'High activity signal: 100+ messages in last 24h on Google Chat',
    'completed', NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '30 minutes');

  -- Active creature: dev agent working on seed data (meta!)
  INSERT INTO creatures (type, tree_id, entity_id, intent, instructions, state, dispatched_at, started_at)
  VALUES ('pull', t_forest_proj, e_dev,
    'Seed ellie-forest database with initial state data',
    '{"task": "Create seed SQL with trees, entities, policies, creatures representing current system state"}'::jsonb,
    'working', NOW(), NOW());


  -- ============================================================
  -- 5. FOREST EVENTS — Initial history
  -- ============================================================

  -- Tree creation events
  INSERT INTO forest_events (kind, tree_id, summary, data) VALUES
    ('tree.created', t_gchat_conv, 'Conversation tree created: Google Chat — Primary',
     '{"channel": "google-chat"}'::jsonb),
    ('tree.created', t_tg_conv, 'Conversation tree created: Telegram — Primary',
     '{"channel": "telegram"}'::jsonb),
    ('tree.created', t_forest_proj, 'Project tree created: Forest Architecture',
     '{"origin": "gchat_conversation", "inspired_by": "dave_architecture_vision"}'::jsonb),
    ('tree.created', t_ellie_proj, 'Project tree created: Ellie Platform',
     '{"origin": "founding", "repos": ["ellie-dev", "ellie-home"]}'::jsonb),
    ('tree.created', t_ws_83, 'Work session tree created: ELLIE-83 GChat crash fix',
     '{"plane_id": "ELLIE-83", "priority": "urgent"}'::jsonb),
    ('tree.created', t_ws_73, 'Work session tree created: ELLIE-73 SIGTERM investigation',
     '{"plane_id": "ELLIE-73", "priority": "medium"}'::jsonb);

  -- State change events
  INSERT INTO forest_events (kind, tree_id, summary, data) VALUES
    ('tree.state_changed', t_forest_proj, 'Forest Architecture promoted from nursery to seedling',
     '{"from": "nursery", "to": "seedling", "reason": "Schema designed, DB provisioned"}'::jsonb),
    ('tree.state_changed', t_ellie_proj, 'Ellie Platform matured — stable after ELLIE-63/65/66/81/83 fixes',
     '{"from": "growing", "to": "mature", "reason": "System stable after recent bugfix sprint"}'::jsonb);

  -- Entity attachment events
  INSERT INTO forest_events (kind, tree_id, entity_id, summary) VALUES
    ('entity.attached', t_forest_proj, e_dev, 'Dev Agent attached to Forest Architecture project'),
    ('entity.attached', t_forest_proj, e_strategy, 'Strategy Agent attached to Forest Architecture project'),
    ('entity.attached', t_forest_proj, e_memory, 'Memory System attached to Forest Architecture project');

  -- Creature events (matching the creatures above)
  INSERT INTO forest_events (kind, tree_id, entity_id, summary) VALUES
    ('creature.dispatched', t_gchat_conv, e_dev, 'Dev Agent dispatched to create forest-schema.sql'),
    ('creature.completed', t_gchat_conv, e_dev, 'Dev Agent completed forest-schema.sql — 10 tables, 3 views, 3 functions'),
    ('creature.dispatched', t_gchat_conv, e_strategy, 'Strategy Agent dispatched for tree taxonomy analysis'),
    ('creature.completed', t_gchat_conv, e_strategy, 'Strategy Agent completed tree base abstraction design'),
    ('creature.dispatched', t_forest_proj, e_dev, 'Dev Agent dispatched to seed ellie-forest database');

END $$;
