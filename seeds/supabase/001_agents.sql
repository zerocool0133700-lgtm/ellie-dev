-- Agents Seed Data
-- Populated from creatures/*.md files
-- This seed replaces the basic INSERT from the migration with richer data

-- Clear existing agents (if any) before reseeding
DELETE FROM agents WHERE name IN ('general', 'dev', 'research', 'content', 'finance', 'strategy', 'critic', 'ops');

-- General Agent (squirrel - breadth-first forager)
INSERT INTO agents (name, type, status, capabilities, tools_enabled, metadata)
VALUES (
  'general',
  'general',
  'active',
  ARRAY[
    'conversation',
    'coordination',
    'task_routing',
    'context_management',
    'general_assistance'
  ],
  ARRAY[
    'forest_bridge',
    'plane_lookup',
    'google_workspace',
    'web_search',
    'memory_extraction',
    'agent_router'
  ],
  jsonb_build_object(
    'species', 'squirrel',
    'cognitive_style', 'breadth-first, context-aware, strategic routing',
    'description', 'Default agent — conversation, coordination, and task routing',
    'persona_name', 'General'
  )
);

-- Dev Agent (ant - depth-first focus) - James
INSERT INTO agents (name, type, status, capabilities, tools_enabled, metadata)
VALUES (
  'dev',
  'dev',
  'active',
  ARRAY[
    'code_implementation',
    'testing',
    'debugging',
    'git',
    'deployment',
    'database_migrations'
  ],
  ARRAY[
    'read', 'write', 'edit', 'glob', 'grep',
    'bash_builds', 'bash_tests', 'systemctl',
    'plane_mcp',
    'forest_bridge_read', 'forest_bridge_write',
    'git',
    'supabase_mcp', 'psql_forest'
  ],
  jsonb_build_object(
    'species', 'ant',
    'cognitive_style', 'depth-first, single-threaded, methodical verification',
    'description', 'Reliable developer who ships quality code on time',
    'persona_name', 'James',
    'produces', ARRAY['code_implementation', 'test_results', 'commit_summary', 'bug_fix_report', 'migration_complete', 'deployment_ready'],
    'consumes', ARRAY['work_item_assignment', 'implementation_spec', 'bug_report', 'scope_clarification', 'architectural_guidance', 'review_feedback']
  )
);

-- Research Agent (squirrel - breadth-first forager) - Kate
INSERT INTO agents (name, type, status, capabilities, tools_enabled, metadata)
VALUES (
  'research',
  'research',
  'active',
  ARRAY[
    'web_search',
    'analysis',
    'summarization',
    'evidence_gathering',
    'source_evaluation',
    'knowledge_synthesis'
  ],
  ARRAY[
    'brave_search',
    'forest_bridge',
    'qmd_search',
    'google_workspace',
    'grep_glob_codebase',
    'memory_extraction'
  ],
  jsonb_build_object(
    'species', 'squirrel',
    'cognitive_style', 'breadth-first, evidence-driven, multi-source synthesis',
    'description', 'Research specialist — gathering, evaluating, and synthesizing information',
    'persona_name', 'Kate',
    'produces', ARRAY['research_findings', 'source_comparison', 'confidence_report', 'evidence_synthesis', 'gap_analysis'],
    'consumes', ARRAY['research_question', 'topic_investigation_request', 'source_verification_request', 'comparative_analysis_request']
  )
);

-- Strategy Agent (bird - breadth-first scanner) - Alan
INSERT INTO agents (name, type, status, capabilities, tools_enabled, metadata)
VALUES (
  'strategy',
  'strategy',
  'active',
  ARRAY[
    'planning',
    'decision_making',
    'roadmapping',
    'market_analysis',
    'feasibility_assessment',
    'opportunity_identification'
  ],
  ARRAY[
    'brave_web_search',
    'forest_bridge_read', 'forest_bridge_write',
    'qmd_search',
    'plane_mcp',
    'miro',
    'memory_extraction'
  ],
  jsonb_build_object(
    'species', 'bird',
    'cognitive_style', 'breadth-first, pattern-recognition, opportunity-identification',
    'description', 'Business analyst and market intelligence scout',
    'persona_name', 'Alan',
    'produces', ARRAY['market_brief', 'competitive_analysis', 'feasibility_report', 'revenue_opportunity_assessment', 'architectural_recommendation', 'prioritization_matrix'],
    'consumes', ARRAY['research_request', 'backlog_grooming_request', 'architectural_decision_needed', 'prioritization_question', 'roadmap_planning_request']
  )
);

-- Ops Agent (ant - depth-first focus) - Jason
INSERT INTO agents (name, type, status, capabilities, tools_enabled, metadata)
VALUES (
  'ops',
  'ops',
  'active',
  ARRAY[
    'infrastructure',
    'monitoring',
    'incident_response',
    'deployment',
    'service_management',
    'health_checks'
  ],
  ARRAY[
    'bash_systemctl', 'bash_journalctl', 'bash_process_mgmt',
    'health_endpoint_checks', 'log_analysis',
    'forest_bridge_read', 'forest_bridge_write',
    'plane_mcp',
    'github_mcp',
    'telegram', 'google_chat'
  ],
  jsonb_build_object(
    'species', 'ant',
    'cognitive_style', 'depth-first, cascading-effects-aware, system-dependency-mapping',
    'description', 'Infrastructure reliability engineer',
    'persona_name', 'Jason',
    'produces', ARRAY['service_health_report', 'incident_response', 'deployment_complete', 'runbook', 'infrastructure_change_summary', 'uptime_trend_analysis'],
    'consumes', ARRAY['incident_alert', 'deployment_request', 'infrastructure_change_request', 'health_check_request', 'log_analysis_request']
  )
);

-- Critic Agent (owl - depth-first, detail-oriented) - Brian
INSERT INTO agents (name, type, status, capabilities, tools_enabled, metadata)
VALUES (
  'critic',
  'critic',
  'active',
  ARRAY[
    'review',
    'feedback',
    'quality_assurance',
    'risk_assessment',
    'edge_case_analysis',
    'blind_spot_detection'
  ],
  ARRAY[
    'read', 'glob', 'grep',
    'forest_bridge_read', 'forest_bridge_write',
    'plane_mcp',
    'bash_tests', 'bash_type_checks'
  ],
  jsonb_build_object(
    'species', 'owl',
    'cognitive_style', 'depth-first, pattern-recognition, systematic-review',
    'description', 'Blind-spot detector and future-proof guardian',
    'persona_name', 'Brian',
    'produces', ARRAY['review_report', 'tiered_findings', 'risk_assessment', 'ship_no_ship_verdict', 'edge_case_analysis', 'consistency_check'],
    'consumes', ARRAY['review_request', 'code_changes', 'architecture_proposal', 'pre_ship_checklist', 'acceptance_criteria']
  )
);

-- Content Agent (ant - depth-first focus) - Amy
INSERT INTO agents (name, type, status, capabilities, tools_enabled, metadata)
VALUES (
  'content',
  'content',
  'active',
  ARRAY[
    'writing',
    'editing',
    'documentation',
    'content_creation',
    'audience_adaptation'
  ],
  ARRAY[
    'google_workspace',
    'forest_bridge_read',
    'qmd_search',
    'brave_web_search',
    'memory_extraction'
  ],
  jsonb_build_object(
    'species', 'ant',
    'cognitive_style', 'depth-first, single-threaded, finish-before-switching',
    'description', 'Content creator and writer',
    'persona_name', 'Amy',
    'produces', ARRAY['documentation', 'social_post', 'video_script', 'newsletter', 'blog_post', 'content_template'],
    'consumes', ARRAY['content_request', 'audience_spec', 'format_spec', 'tone_guidance', 'revision_feedback']
  )
);

-- Finance Agent (ant - depth-first focus) - Marcus
INSERT INTO agents (name, type, status, capabilities, tools_enabled, metadata)
VALUES (
  'finance',
  'finance',
  'active',
  ARRAY[
    'budgeting',
    'analysis',
    'reporting',
    'transaction_tracking',
    'forecasting',
    'pattern_analysis'
  ],
  ARRAY[
    'plane_mcp',
    'forest_bridge_read', 'forest_bridge_write',
    'memory_extraction',
    'transaction_import', 'receipt_parsing'
  ],
  jsonb_build_object(
    'species', 'ant',
    'cognitive_style', 'metrics-driven, depth-first financial analysis',
    'description', 'Trusted CFO and financial analyst. Tracks spending, forecasts budgets, and flags financial decisions with calm, data-driven precision.',
    'persona_name', 'Marcus',
    'produces', ARRAY['spending_report', 'budget_forecast', 'transaction_detail', 'subscription_audit', 'financial_impact_assessment', 'roi_analysis'],
    'consumes', ARRAY['financial_query', 'spending_review_request', 'budget_approval', 'transaction_categorization', 'subscription_decision']
  )
);
