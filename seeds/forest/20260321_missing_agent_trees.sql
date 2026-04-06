-- Create Forest trees for missing agents
-- Ellie (general), Kate (research), Alan (strategy), Jason (ops), Marcus (finance)
-- Follows same pattern as James/Brian/Amy from 20260317_agent_trees.sql and 20260317_amy_forest_setup.sql

-- ── 1. Ensure RBAC roles exist ──────────────────────────────────

INSERT INTO rbac_roles (id, name, parent_role_id, description)
VALUES
  ('a0000000-0000-0000-0000-000000000006', 'general_agent', 'a0000000-0000-0000-0000-000000000001', 'General agent: coordination, routing, knowledge management'),
  ('a0000000-0000-0000-0000-000000000007', 'strategy_agent', 'a0000000-0000-0000-0000-000000000001', 'Strategy agent: business analysis, market intelligence'),
  ('a0000000-0000-0000-0000-000000000008', 'ops_agent', 'a0000000-0000-0000-0000-000000000001', 'Ops agent: infrastructure, monitoring, deployment'),
  ('a0000000-0000-0000-0000-000000000009', 'finance_agent', 'a0000000-0000-0000-0000-000000000001', 'Finance agent: spending analysis, budget tracking')
ON CONFLICT (name) DO NOTHING;

-- ── 2. Create Forest entities ────────────────────────────────────

-- Ellie (General agent)
INSERT INTO entities (id, name, display_name, type, contribution, capabilities, config)
VALUES (
  'e0000000-0000-0000-0000-000000000010',
  'ellie', 'Ellie', 'agent', 'many_trees',
  '["coordination", "routing", "knowledge_management", "conversation", "task_tracking"]'::jsonb,
  '{"archetype": "general", "species": "squirrel"}'::jsonb
) ON CONFLICT (name) DO NOTHING;

-- Kate (Research agent)
INSERT INTO entities (id, name, display_name, type, contribution, capabilities, config)
VALUES (
  'e0000000-0000-0000-0000-000000000011',
  'kate', 'Kate', 'agent', 'many_trees',
  '["web_search", "analysis", "evidence_gathering", "synthesis"]'::jsonb,
  '{"archetype": "research", "species": "squirrel"}'::jsonb
) ON CONFLICT (name) DO NOTHING;

-- Alan (Strategy agent)
INSERT INTO entities (id, name, display_name, type, contribution, capabilities, config)
VALUES (
  'e0000000-0000-0000-0000-000000000012',
  'alan', 'Alan', 'agent', 'many_trees',
  '["business_analysis", "market_intelligence", "competitive_research", "feasibility_assessment"]'::jsonb,
  '{"archetype": "strategy", "species": "bird"}'::jsonb
) ON CONFLICT (name) DO NOTHING;

-- Jason (Ops agent)
INSERT INTO entities (id, name, display_name, type, contribution, capabilities, config)
VALUES (
  'e0000000-0000-0000-0000-000000000013',
  'jason', 'Jason', 'agent', 'many_trees',
  '["infrastructure", "monitoring", "incident_response", "deployment", "health_checks"]'::jsonb,
  '{"archetype": "jason", "species": "ant"}'::jsonb
) ON CONFLICT (name) DO NOTHING;

-- Marcus (Finance agent)
INSERT INTO entities (id, name, display_name, type, contribution, capabilities, config)
VALUES (
  'e0000000-0000-0000-0000-000000000014',
  'marcus', 'Marcus', 'agent', 'many_trees',
  '["spending_analysis", "budget_tracking", "transaction_categorization", "financial_reporting"]'::jsonb,
  '{"archetype": "finance", "species": "ant"}'::jsonb
) ON CONFLICT (name) DO NOTHING;

-- ── 3. Create RBAC entities ──────────────────────────────────────

INSERT INTO rbac_entities (id, entity_type, name, archetype, metadata)
VALUES
  ('e0000000-0000-0000-0000-000000000010', 'agent', 'Ellie', 'general',
   '{"species": "squirrel", "forest_entity_id": "e0000000-0000-0000-0000-000000000010"}'::jsonb),
  ('e0000000-0000-0000-0000-000000000011', 'agent', 'Kate', 'kate',
   '{"species": "squirrel", "forest_entity_id": "e0000000-0000-0000-0000-000000000011"}'::jsonb),
  ('e0000000-0000-0000-0000-000000000012', 'agent', 'Alan', 'alan',
   '{"species": "bird", "forest_entity_id": "e0000000-0000-0000-0000-000000000012"}'::jsonb),
  ('e0000000-0000-0000-0000-000000000013', 'agent', 'Jason', 'jason',
   '{"species": "ant", "forest_entity_id": "e0000000-0000-0000-0000-000000000013"}'::jsonb),
  ('e0000000-0000-0000-0000-000000000014', 'agent', 'Marcus', 'marcus',
   '{"species": "ant", "forest_entity_id": "e0000000-0000-0000-0000-000000000014"}'::jsonb)
ON CONFLICT (id) DO UPDATE SET
  entity_type = EXCLUDED.entity_type,
  name = EXCLUDED.name,
  archetype = EXCLUDED.archetype,
  metadata = EXCLUDED.metadata;

-- ── 4. Create people records ─────────────────────────────────────

INSERT INTO people (id, name, relationship_type, notes, entity_id)
VALUES
  ('e0000000-0000-0000-0000-000000000010', 'Ellie', 'agent',
   'General agent — squirrel archetype, coordinator and companion', 'e0000000-0000-0000-0000-000000000010'),
  ('e0000000-0000-0000-0000-000000000011', 'Kate', 'agent',
   'Research agent — squirrel archetype, evidence-driven analysis', 'e0000000-0000-0000-0000-000000000011'),
  ('e0000000-0000-0000-0000-000000000012', 'Alan', 'agent',
   'Strategy agent — bird archetype, business intelligence scout', 'e0000000-0000-0000-0000-000000000012'),
  ('e0000000-0000-0000-0000-000000000013', 'Jason', 'agent',
   'Ops agent — ant archetype, infrastructure reliability', 'e0000000-0000-0000-0000-000000000013'),
  ('e0000000-0000-0000-0000-000000000014', 'Marcus', 'agent',
   'Finance agent — ant archetype, financial analysis and tracking', 'e0000000-0000-0000-0000-000000000014')
ON CONFLICT (id) DO NOTHING;

-- ── 5. Create person trees ───────────────────────────────────────

INSERT INTO trees (id, type, state, title, description, metadata)
VALUES
  ('f0000000-0000-0000-0000-000000000010', 'person', 'seedling', 'Ellie',
   'Personal knowledge tree for Ellie (general agent)',
   '{"entity_id": "e0000000-0000-0000-0000-000000000010", "archetype": "general"}'::jsonb),
  ('f0000000-0000-0000-0000-000000000011', 'person', 'seedling', 'Kate',
   'Personal knowledge tree for Kate (research agent)',
   '{"entity_id": "e0000000-0000-0000-0000-000000000011", "archetype": "research"}'::jsonb),
  ('f0000000-0000-0000-0000-000000000012', 'person', 'seedling', 'Alan',
   'Personal knowledge tree for Alan (strategy agent)',
   '{"entity_id": "e0000000-0000-0000-0000-000000000012", "archetype": "strategy"}'::jsonb),
  ('f0000000-0000-0000-0000-000000000013', 'person', 'seedling', 'Jason',
   'Personal knowledge tree for Jason (ops agent)',
   '{"entity_id": "e0000000-0000-0000-0000-000000000013", "archetype": "jason"}'::jsonb),
  ('f0000000-0000-0000-0000-000000000014', 'person', 'seedling', 'Marcus',
   'Personal knowledge tree for Marcus (finance agent)',
   '{"entity_id": "e0000000-0000-0000-0000-000000000014", "archetype": "finance"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- ── 6. Link people to trees ──────────────────────────────────────

UPDATE people SET tree_id = 'f0000000-0000-0000-0000-000000000010'
WHERE id = 'e0000000-0000-0000-0000-000000000010' AND tree_id IS NULL;

UPDATE people SET tree_id = 'f0000000-0000-0000-0000-000000000011'
WHERE id = 'e0000000-0000-0000-0000-000000000011' AND tree_id IS NULL;

UPDATE people SET tree_id = 'f0000000-0000-0000-0000-000000000012'
WHERE id = 'e0000000-0000-0000-0000-000000000012' AND tree_id IS NULL;

UPDATE people SET tree_id = 'f0000000-0000-0000-0000-000000000013'
WHERE id = 'e0000000-0000-0000-0000-000000000013' AND tree_id IS NULL;

UPDATE people SET tree_id = 'f0000000-0000-0000-0000-000000000014'
WHERE id = 'e0000000-0000-0000-0000-000000000014' AND tree_id IS NULL;

-- ── 7. Assign RBAC roles ─────────────────────────────────────────

INSERT INTO rbac_entity_roles (entity_id, role_id, granted_by)
VALUES
  ('e0000000-0000-0000-0000-000000000010', 'a0000000-0000-0000-0000-000000000006', 'e0000000-0000-0000-0000-000000000001'),  -- Ellie → general_agent
  ('e0000000-0000-0000-0000-000000000011', 'a0000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000001'),  -- Kate → research_agent
  ('e0000000-0000-0000-0000-000000000012', 'a0000000-0000-0000-0000-000000000007', 'e0000000-0000-0000-0000-000000000001'),  -- Alan → strategy_agent
  ('e0000000-0000-0000-0000-000000000013', 'a0000000-0000-0000-0000-000000000008', 'e0000000-0000-0000-0000-000000000001'),  -- Jason → ops_agent
  ('e0000000-0000-0000-0000-000000000014', 'a0000000-0000-0000-0000-000000000009', 'e0000000-0000-0000-0000-000000000001')   -- Marcus → finance_agent
ON CONFLICT (entity_id, role_id) DO NOTHING;

-- ── 8. Add agents to project groves ──────────────────────────────

-- Ellie gets write access to all groves (coordinator role)
INSERT INTO group_memberships (group_id, person_id, role, access_level)
VALUES
  ('a1000000-0000-0000-0000-000000000010', 'e0000000-0000-0000-0000-000000000010', 'contributor', 'write'),  -- ellie-dev-grove
  ('a1000000-0000-0000-0000-000000000011', 'e0000000-0000-0000-0000-000000000010', 'contributor', 'write'),  -- ellie-forest-grove
  ('a1000000-0000-0000-0000-000000000012', 'e0000000-0000-0000-0000-000000000010', 'contributor', 'write')   -- ellie-home-grove
ON CONFLICT (group_id, person_id) DO NOTHING;

-- Kate gets write access to all groves (research spans all domains)
INSERT INTO group_memberships (group_id, person_id, role, access_level)
VALUES
  ('a1000000-0000-0000-0000-000000000010', 'e0000000-0000-0000-0000-000000000011', 'contributor', 'write'),
  ('a1000000-0000-0000-0000-000000000011', 'e0000000-0000-0000-0000-000000000011', 'contributor', 'write'),
  ('a1000000-0000-0000-0000-000000000012', 'e0000000-0000-0000-0000-000000000011', 'contributor', 'write')
ON CONFLICT (group_id, person_id) DO NOTHING;

-- Alan gets write access to all groves (strategy requires broad context)
INSERT INTO group_memberships (group_id, person_id, role, access_level)
VALUES
  ('a1000000-0000-0000-0000-000000000010', 'e0000000-0000-0000-0000-000000000012', 'contributor', 'write'),
  ('a1000000-0000-0000-0000-000000000011', 'e0000000-0000-0000-0000-000000000012', 'contributor', 'write'),
  ('a1000000-0000-0000-0000-000000000012', 'e0000000-0000-0000-0000-000000000012', 'contributor', 'write')
ON CONFLICT (group_id, person_id) DO NOTHING;

-- Jason gets write access to ellie-dev (ops primarily works on infrastructure)
INSERT INTO group_memberships (group_id, person_id, role, access_level)
VALUES
  ('a1000000-0000-0000-0000-000000000010', 'e0000000-0000-0000-0000-000000000013', 'contributor', 'write'),
  ('a1000000-0000-0000-0000-000000000011', 'e0000000-0000-0000-0000-000000000013', 'observer', 'read'),
  ('a1000000-0000-0000-0000-000000000012', 'e0000000-0000-0000-0000-000000000013', 'observer', 'read')
ON CONFLICT (group_id, person_id) DO NOTHING;

-- Marcus gets read access to all groves (finance tracks across all projects)
INSERT INTO group_memberships (group_id, person_id, role, access_level)
VALUES
  ('a1000000-0000-0000-0000-000000000010', 'e0000000-0000-0000-0000-000000000014', 'observer', 'read'),
  ('a1000000-0000-0000-0000-000000000011', 'e0000000-0000-0000-0000-000000000014', 'observer', 'read'),
  ('a1000000-0000-0000-0000-000000000012', 'e0000000-0000-0000-0000-000000000014', 'observer', 'read')
ON CONFLICT (group_id, person_id) DO NOTHING;
