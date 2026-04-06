-- Fixup for missing agent RBAC entities
-- The main seed created Forest entities, people, and trees successfully
-- This completes the RBAC wiring

-- ── 1. Create RBAC entities for Kate, Alan, Jason, Marcus ────────

INSERT INTO rbac_entities (id, entity_type, name, archetype, metadata)
VALUES
  ('e0000000-0000-0000-0000-000000000011', 'agent', 'Kate', 'research',
   '{"species": "squirrel", "forest_entity_id": "e0000000-0000-0000-0000-000000000011"}'::jsonb),
  ('e0000000-0000-0000-0000-000000000012', 'agent', 'Alan', 'alan',
   '{"species": "bird", "forest_entity_id": "e0000000-0000-0000-0000-000000000012"}'::jsonb),
  ('e0000000-0000-0000-0000-000000000013', 'agent', 'Jason', 'ops',
   '{"species": "ant", "forest_entity_id": "e0000000-0000-0000-0000-000000000013"}'::jsonb),
  ('e0000000-0000-0000-0000-000000000014', 'agent', 'Marcus', 'marcus',
   '{"species": "ant", "forest_entity_id": "e0000000-0000-0000-0000-000000000014"}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- ── 2. Update Ellie's existing RBAC entity ────────────────────────

-- Ellie already exists as e0...02 (super_agent) from earlier migration
-- Update her metadata to reference the new Forest entity
UPDATE rbac_entities
SET metadata = jsonb_set(
  metadata,
  '{forest_entity_id}',
  '"e0000000-0000-0000-0000-000000000010"'::jsonb
)
WHERE id = 'e0000000-0000-0000-0000-000000000002';

-- ── 3. Assign RBAC roles ──────────────────────────────────────────

INSERT INTO rbac_entity_roles (entity_id, role_id, granted_by)
VALUES
  -- Ellie gets general_agent role (in addition to her super_agent role)
  ('e0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000006', 'e0000000-0000-0000-0000-000000000001'),
  -- Kate, Alan, Jason, Marcus get their respective roles
  ('e0000000-0000-0000-0000-000000000011', 'a0000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000001'),  -- Kate → research_agent
  ('e0000000-0000-0000-0000-000000000012', 'a0000000-0000-0000-0000-000000000007', 'e0000000-0000-0000-0000-000000000001'),  -- Alan → strategy_agent
  ('e0000000-0000-0000-0000-000000000013', 'a0000000-0000-0000-0000-000000000008', 'e0000000-0000-0000-0000-000000000001'),  -- Jason → ops_agent
  ('e0000000-0000-0000-0000-000000000014', 'a0000000-0000-0000-0000-000000000009', 'e0000000-0000-0000-0000-000000000001')   -- Marcus → finance_agent
ON CONFLICT (entity_id, role_id) DO NOTHING;

-- ── 4. Link Ellie's people record to the RBAC entity ──────────────

-- Update Ellie's people record to reference the correct RBAC entity
UPDATE people
SET entity_id = 'e0000000-0000-0000-0000-000000000010'
WHERE id = 'e0000000-0000-0000-0000-000000000010';
