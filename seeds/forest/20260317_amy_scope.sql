-- Amy's knowledge scope (private workspace)
-- Brian's scope already exists from ELLIE-827 work
-- This creates Amy's parallel scope structure

INSERT INTO knowledge_scopes (id, path, name, level, parent_id, description)
VALUES (
  'b0000000-0000-0000-0000-000000000005',
  '3/amy',
  'Amy',
  'agent',
  'b0000000-0000-0000-0000-000000000001',  -- parent: Agents (3)
  'Amy (Content agent) private workspace — writing, docs, content creation'
) ON CONFLICT (path) DO NOTHING;
