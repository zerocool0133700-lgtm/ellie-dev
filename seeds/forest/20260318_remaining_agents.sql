-- Add remaining persona-named agents to Forest
-- Completes the set started by 20260317_brian_amy_agents.sql

-- James (Dev agent)
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
  'e0000000-0000-0000-0000-000000000001',
  'james',
  'James',
  'ant',
  'active',
  ARRAY['code_implementation', 'testing', 'debugging', 'git', 'deployment', 'database_migrations'],
  ARRAY['read', 'write', 'edit', 'glob', 'grep', 'bash_builds', 'bash_tests', 'systemctl', 'plane_mcp', 'forest_bridge_read', 'forest_bridge_write', 'git', 'supabase_mcp', 'psql_forest'],
  'Reliable developer who ships quality code on time',
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

-- Kate (Research agent)
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
  'e0000000-0000-0000-0000-000000000002',
  'kate',
  'Kate',
  'squirrel',
  'active',
  ARRAY['web_search', 'analysis', 'summarization', 'evidence_gathering', 'source_evaluation', 'knowledge_synthesis'],
  ARRAY['brave_search', 'forest_bridge', 'qmd_search', 'google_workspace', 'grep_glob_codebase', 'memory_extraction'],
  'Research specialist — gathering, evaluating, and synthesizing information',
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

-- Alan (Strategy agent)
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
  'e0000000-0000-0000-0000-000000000003',
  'alan',
  'Alan',
  'squirrel',
  'active',
  ARRAY['planning', 'decision_making', 'roadmapping', 'market_analysis', 'feasibility_assessment', 'opportunity_identification'],
  ARRAY['brave_web_search', 'forest_bridge_read', 'forest_bridge_write', 'qmd_search', 'plane_mcp', 'miro', 'memory_extraction'],
  'Business analyst and market intelligence scout',
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

-- Jason (Ops agent)
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
  'e0000000-0000-0000-0000-000000000006',
  'jason',
  'Jason',
  'ant',
  'active',
  ARRAY['infrastructure', 'monitoring', 'incident_response', 'deployment', 'service_management', 'health_checks'],
  ARRAY['bash_systemctl', 'bash_journalctl', 'bash_process_mgmt', 'health_endpoint_checks', 'log_analysis', 'forest_bridge_read', 'forest_bridge_write', 'plane_mcp', 'github_mcp', 'telegram', 'google_chat'],
  'Infrastructure reliability engineer',
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
