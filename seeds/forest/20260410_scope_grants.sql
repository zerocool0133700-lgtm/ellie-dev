-- ELLIE-1535: Seed scope_grants with persona grant patterns from round table design
-- Demonstrates: Landlord (Dave), Tenant (Betty), Manager (Allen), Agent (James)

-- 1. Create the Land scope hierarchy for ellie-pro
--    Using path prefix 'L' for land (avoids collision with existing numeric scopes)
INSERT INTO knowledge_scopes (id, path, name, level, parent_id) VALUES
  ('d0000000-0000-0000-0000-000000000001', 'L',   'Land',                 'domain', NULL),
  ('d0000000-0000-0000-0000-000000000002', 'L/1', 'White River National Forest', 'land', 'd0000000-0000-0000-0000-000000000001'),
  ('d0000000-0000-0000-0000-000000000003', 'L/1/1', 'Main Lodge',         'tree',   'd0000000-0000-0000-0000-000000000002'),
  ('d0000000-0000-0000-0000-000000000004', 'L/1/2', 'East Cabin',         'tree',   'd0000000-0000-0000-0000-000000000002'),
  ('d0000000-0000-0000-0000-000000000005', 'L/1/3', 'River House',        'tree',   'd0000000-0000-0000-0000-000000000002'),
  ('d0000000-0000-0000-0000-000000000006', 'L/1/4', 'Guest Cottage',      'tree',   'd0000000-0000-0000-0000-000000000002'),
  ('d0000000-0000-0000-0000-000000000007', 'L/1/5', 'Hilltop Suite',      'tree',   'd0000000-0000-0000-0000-000000000002')
ON CONFLICT (path) DO NOTHING;

-- 2. Create persona entities (Betty = tenant, Allen = manager)
INSERT INTO rbac_entities (id, entity_type, name, archetype, metadata) VALUES
  ('e0000000-0000-0000-0000-000000000020', 'user', 'Betty', 'tenant',  '{"persona": "tenant", "description": "Tenant with access to specific property"}'),
  ('e0000000-0000-0000-0000-000000000021', 'user', 'Allen', 'manager', '{"persona": "manager", "description": "Property manager with delegation rights"}')
ON CONFLICT (name) DO NOTHING;

-- 3. Seed the four persona grant patterns

-- Landlord (Dave): cascading grant on land root scope — can see everything
INSERT INTO scope_grants (subject_id, scope_id, scope_path, permission_id, cascading, granted_by) VALUES
  -- forest.read cascading on Land root
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'L',
   'b0000000-0000-0000-0002-000000000001', true, 'e0000000-0000-0000-0000-000000000001'),
  -- forest.write cascading on Land root
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'L',
   'b0000000-0000-0000-0002-000000000002', true, 'e0000000-0000-0000-0000-000000000001'),
  -- forest.manage_scopes cascading on Land root
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'L',
   'b0000000-0000-0000-0002-000000000004', true, 'e0000000-0000-0000-0000-000000000001')
ON CONFLICT (subject_id, scope_id, permission_id) DO NOTHING;

-- Tenant (Betty): non-cascading grant on specific tree scope (Hilltop Suite L/1/5)
INSERT INTO scope_grants (subject_id, scope_id, scope_path, permission_id, cascading, granted_by) VALUES
  -- forest.read on Hilltop Suite only
  ('e0000000-0000-0000-0000-000000000020', 'd0000000-0000-0000-0000-000000000007', 'L/1/5',
   'b0000000-0000-0000-0002-000000000001', false, 'e0000000-0000-0000-0000-000000000001')
ON CONFLICT (subject_id, scope_id, permission_id) DO NOTHING;

-- Manager (Allen): cascading grant on land root with delegation rights
INSERT INTO scope_grants (subject_id, scope_id, scope_path, permission_id, cascading, granted_by) VALUES
  -- forest.read cascading on Land root
  ('e0000000-0000-0000-0000-000000000021', 'd0000000-0000-0000-0000-000000000001', 'L',
   'b0000000-0000-0000-0002-000000000001', true, 'e0000000-0000-0000-0000-000000000001'),
  -- forest.write cascading on Land root
  ('e0000000-0000-0000-0000-000000000021', 'd0000000-0000-0000-0000-000000000001', 'L',
   'b0000000-0000-0000-0002-000000000002', true, 'e0000000-0000-0000-0000-000000000001'),
  -- forest.manage_scopes cascading (delegation rights)
  ('e0000000-0000-0000-0000-000000000021', 'd0000000-0000-0000-0000-000000000001', 'L',
   'b0000000-0000-0000-0002-000000000004', true, 'e0000000-0000-0000-0000-000000000001')
ON CONFLICT (subject_id, scope_id, permission_id) DO NOTHING;

-- Agent (James): non-cascading grant on assigned tree scope (Main Lodge L/1/1)
INSERT INTO scope_grants (subject_id, scope_id, scope_path, permission_id, cascading, granted_by) VALUES
  -- forest.read on Main Lodge only
  ('e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000003', 'L/1/1',
   'b0000000-0000-0000-0002-000000000001', false, 'e0000000-0000-0000-0000-000000000001'),
  -- forest.write on Main Lodge only
  ('e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000003', 'L/1/1',
   'b0000000-0000-0000-0002-000000000002', false, 'e0000000-0000-0000-0000-000000000001')
ON CONFLICT (subject_id, scope_id, permission_id) DO NOTHING;
