-- Add routing rule for critic agent (previously unreachable via auto-routing)
INSERT INTO routing_rules (name, description, priority, conditions, target_agent_id)
SELECT 'critic_keywords', 'Route review/feedback tasks to critic agent', 9,
  '{"keywords": ["review", "critique", "feedback", "evaluate", "assess", "audit", "check my", "what do you think", "pros and cons"]}'::jsonb,
  id FROM agents WHERE name = 'critic';
