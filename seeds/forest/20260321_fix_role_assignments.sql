-- Fix RBAC role assignments for agents
-- The role IDs in the database don't match what we expected

-- Current state (WRONG):
-- Alan   → finance_agent (a0...07)
-- Jason  → content_agent (a0...08)
-- Marcus → general_agent (a0...09)
-- Ellie  → strategy_agent (a0...06)

-- Correct mapping from database:
-- a0...02 = dev_agent
-- a0...03 = critic_agent
-- a0...04 = research_agent
-- a0...06 = strategy_agent
-- a0...07 = finance_agent
-- a0...08 = content_agent
-- a0...09 = general_agent

-- Need to create:
-- ops_agent (assign to Jason)

-- ── 1. Create missing ops_agent role ──────────────────────────────

INSERT INTO rbac_roles (id, name, parent_role_id, description)
VALUES (
  'a0000000-0000-0000-0000-000000000010',
  'ops_agent',
  'a0000000-0000-0000-0000-000000000001',
  'Ops agent: infrastructure, monitoring, deployment'
) ON CONFLICT (name) DO NOTHING;

-- ── 2. Delete incorrect role assignments ──────────────────────────

-- Delete all agent role assignments for the 5 new agents
DELETE FROM rbac_entity_roles
WHERE entity_id IN (
  'e0000000-0000-0000-0000-000000000002',  -- Ellie
  'e0000000-0000-0000-0000-000000000011',  -- Kate
  'e0000000-0000-0000-0000-000000000012',  -- Alan
  'e0000000-0000-0000-0000-000000000013',  -- Jason
  'e0000000-0000-0000-0000-000000000014'   -- Marcus
)
AND role_id IN (
  'a0000000-0000-0000-0000-000000000004',  -- research_agent
  'a0000000-0000-0000-0000-000000000006',  -- strategy_agent
  'a0000000-0000-0000-0000-000000000007',  -- finance_agent
  'a0000000-0000-0000-0000-000000000008',  -- content_agent
  'a0000000-0000-0000-0000-000000000009',  -- general_agent
  'a0000000-0000-0000-0000-000000000010'   -- ops_agent
);

-- Keep Ellie's super_agent role - that's correct

-- ── 3. Assign correct roles ───────────────────────────────────────

INSERT INTO rbac_entity_roles (entity_id, role_id, granted_by)
VALUES
  -- Ellie → general_agent
  ('e0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000009', 'e0000000-0000-0000-0000-000000000001'),
  -- Kate → research_agent
  ('e0000000-0000-0000-0000-000000000011', 'a0000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000001'),
  -- Alan → strategy_agent
  ('e0000000-0000-0000-0000-000000000012', 'a0000000-0000-0000-0000-000000000006', 'e0000000-0000-0000-0000-000000000001'),
  -- Jason → ops_agent
  ('e0000000-0000-0000-0000-000000000013', 'a0000000-0000-0000-0000-000000000010', 'e0000000-0000-0000-0000-000000000001'),
  -- Marcus → finance_agent
  ('e0000000-0000-0000-0000-000000000014', 'a0000000-0000-0000-0000-000000000007', 'e0000000-0000-0000-0000-000000000001')
ON CONFLICT (entity_id, role_id) DO NOTHING;
