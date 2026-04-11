-- Brian and Amy agent registration in Forest
-- Part of agent activation testing (Phase 1: Forest/Grove setup)

-- Brian (Critic agent)
INSERT INTO agents (
  id,
  name,
  display_name,
  species,
  status,
  capabilities,
  tools_enabled,
  description,
  model
) VALUES (
  'e0000000-0000-0000-0000-000000000004',
  'brian',
  'Brian',
  'owl',
  'active',
  ARRAY['review', 'feedback', 'quality_assurance', 'risk_assessment', 'edge_case_analysis', 'blind_spot_detection'],
  ARRAY['read', 'glob', 'grep', 'forest_bridge_read', 'forest_bridge_write', 'plane_mcp', 'bash_tests', 'bash_type_checks'],
  'Blind-spot detector and future-proof guardian',
  'claude-sonnet-4-5-20250929'
) ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  display_name = EXCLUDED.display_name,
  species = EXCLUDED.species,
  status = EXCLUDED.status,
  capabilities = EXCLUDED.capabilities,
  tools_enabled = EXCLUDED.tools_enabled,
  description = EXCLUDED.description,
  model = EXCLUDED.model;

-- Amy (Content agent)
INSERT INTO agents (
  id,
  name,
  display_name,
  species,
  status,
  capabilities,
  tools_enabled,
  description,
  model
) VALUES (
  'e0000000-0000-0000-0000-000000000005',
  'amy',
  'Amy',
  'ant',
  'active',
  ARRAY['writing', 'editing', 'documentation', 'content_creation', 'audience_adaptation'],
  ARRAY['google_workspace', 'forest_bridge_read', 'qmd_search', 'brave_web_search', 'memory_extraction'],
  'Content creator and writer',
  'claude-sonnet-4-5-20250929'
) ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  display_name = EXCLUDED.display_name,
  species = EXCLUDED.species,
  status = EXCLUDED.status,
  capabilities = EXCLUDED.capabilities,
  tools_enabled = EXCLUDED.tools_enabled,
  description = EXCLUDED.description,
  model = EXCLUDED.model;
