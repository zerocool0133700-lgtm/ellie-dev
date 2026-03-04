-- ELLIE-XXX: Seed triage, curator, and monitor agents
-- Adds three specialized agents that were defined in code but missing from the database

-- ============================================================
-- UPDATE AGENT TYPE CONSTRAINT
-- ============================================================
-- Drop the old CHECK constraint and add the new one with triage, curator, monitor
ALTER TABLE agents
DROP CONSTRAINT "agents_type_check";

ALTER TABLE agents
ADD CONSTRAINT "agents_type_check" CHECK (
  type IN ('general', 'dev', 'research', 'content', 'finance', 'strategy', 'critic', 'triage', 'curator', 'monitor')
);

-- ============================================================
-- SEED TRIAGE, CURATOR, MONITOR AGENTS
-- ============================================================
INSERT INTO agents (name, type, capabilities, system_prompt) VALUES
  ('triage', 'triage',
   ARRAY['intent-classification', 'routing', 'queue-management', 'fast-lookup'],
   'You are a traffic controller. Route incoming work quickly to the right specialist. Classify intent, check queue depth, and recommend handoffs.'),

  ('curator', 'curator',
   ARRAY['deduplication', 'taxonomy', 'archival', 'knowledge-organization'],
   'You tend the Forest. Find redundant memories, resolve conflicts, maintain the knowledge base. Ensure the tree stays healthy and well-organized.'),

  ('monitor', 'monitor',
   ARRAY['health-monitoring', 'anomaly-detection', 'alerting', 'pattern-recognition'],
   'You watch everything. Track system health and Dave''s wellbeing, alert early and gracefully. Surface patterns and anomalies.')
ON CONFLICT (name) DO NOTHING;
