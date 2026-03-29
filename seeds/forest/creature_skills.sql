-- Seed: Archetype Default Skills and Creature Skills
-- Task 4 of Orchestrator Observability (ELLIE-1131)
-- Skill names match directory names under skills/*/SKILL.md

-- ============================================================
-- Part 1: Archetype Default Skills
-- Maps archetypes to the skills they should have by default
-- ============================================================

INSERT INTO archetype_default_skills (archetype, skill_name) VALUES

-- dev: code, architecture, quality tooling
  ('dev', 'github'),
  ('dev', 'plane'),
  ('dev', 'forest'),
  ('dev', 'memory'),
  ('dev', 'briefing'),
  ('dev', 'google-workspace'),
  ('dev', 'miro'),
  ('dev', 'architecture-review'),
  ('dev', 'audit'),
  ('dev', 'docker'),
  ('dev', 'obsidian'),
  ('dev', 'verify'),
  ('dev', 'browser'),
  ('dev', 'quality-review'),

-- research: information gathering and synthesis
  ('research', 'forest'),
  ('research', 'memory'),
  ('research', 'briefing'),
  ('research', 'google-workspace'),
  ('research', 'browser'),
  ('research', 'research'),
  ('research', 'miro'),
  ('research', 'obsidian'),
  ('research', 'plane'),
  ('research', 'analytics'),
  ('research', 'relationship-tracker'),

-- finance: financial tracking, analysis, reporting
  ('finance', 'forest'),
  ('finance', 'memory'),
  ('finance', 'briefing'),
  ('finance', 'google-workspace'),
  ('finance', 'finance'),
  ('finance', 'plane'),
  ('finance', 'analytics'),
  ('finance', 'ellie-reports'),
  ('finance', 'obsidian'),

-- general: broad utility — ellie's default kit
  ('general', 'forest'),
  ('general', 'memory'),
  ('general', 'briefing'),
  ('general', 'google-workspace'),
  ('general', 'plane'),
  ('general', 'calendar-intel'),
  ('general', 'caldav-calendar'),
  ('general', 'comms'),
  ('general', 'agentmail'),
  ('general', 'alert'),
  ('general', 'analytics'),
  ('general', 'daily-briefing'),
  ('general', 'gtd'),
  ('general', 'browser'),
  ('general', 'weather'),
  ('general', 'meeting-prep'),
  ('general', 'relationship-tracker'),

-- strategy: planning, vision, forward-thinking
  ('strategy', 'forest'),
  ('strategy', 'memory'),
  ('strategy', 'briefing'),
  ('strategy', 'google-workspace'),
  ('strategy', 'miro'),
  ('strategy', 'plane'),
  ('strategy', 'research'),
  ('strategy', 'strategy'),
  ('strategy', 'context-strategy'),
  ('strategy', 'analytics'),
  ('strategy', 'obsidian'),
  ('strategy', 'meeting-prep'),

-- critic: review, validation, quality gating
  ('critic', 'forest'),
  ('critic', 'memory'),
  ('critic', 'briefing'),
  ('critic', 'plane'),
  ('critic', 'critique'),
  ('critic', 'quality-review'),
  ('critic', 'architecture-review'),
  ('critic', 'verify'),
  ('critic', 'audit'),

-- content: writing, creation, publishing
  ('content', 'forest'),
  ('content', 'memory'),
  ('content', 'briefing'),
  ('content', 'google-workspace'),
  ('content', 'plane'),
  ('content', 'content'),
  ('content', 'miro'),
  ('content', 'obsidian'),
  ('content', 'browser'),
  ('content', 'research'),
  ('content', 'analytics'),
  ('content', 'agentmail'),

-- ops: infrastructure, automation, monitoring
  ('ops', 'forest'),
  ('ops', 'memory'),
  ('ops', 'briefing'),
  ('ops', 'plane'),
  ('ops', 'ops'),
  ('ops', 'docker'),
  ('ops', 'github'),
  ('ops', 'alert'),
  ('ops', 'audit'),
  ('ops', 'analytics'),
  ('ops', 'n8n'),
  ('ops', 'automation-workflows'),
  ('ops', 'verify'),
  ('ops', 'google-workspace')

ON CONFLICT DO NOTHING;

-- ============================================================
-- Part 2: Creature Skills — Named agents with known archetypes
-- ============================================================

-- ellie (squirrel / general) — the main assistant, full kit
INSERT INTO creature_skills (creature_id, skill_name, added_by)
SELECT e.id, s.skill_name, 'seed'
FROM entities e
CROSS JOIN (VALUES
  ('forest'), ('memory'), ('briefing'), ('google-workspace'),
  ('plane'), ('calendar-intel'), ('caldav-calendar'), ('comms'),
  ('agentmail'), ('alert'), ('analytics'), ('daily-briefing'),
  ('gtd'), ('browser'), ('weather'), ('meeting-prep'),
  ('relationship-tracker'), ('github'), ('miro'), ('obsidian'),
  ('ellie-reports'), ('context-strategy'), ('agent-memory')
) AS s(skill_name)
WHERE e.name = 'ellie'
ON CONFLICT DO NOTHING;

-- james (ant / dev)
INSERT INTO creature_skills (creature_id, skill_name, added_by)
SELECT e.id, s.skill_name, 'seed'
FROM entities e
CROSS JOIN (VALUES
  ('github'), ('plane'), ('forest'), ('memory'), ('briefing'),
  ('google-workspace'), ('miro'), ('architecture-review'), ('audit'),
  ('docker'), ('obsidian'), ('verify'), ('browser'), ('quality-review'),
  ('agent-memory')
) AS s(skill_name)
WHERE e.name = 'james'
ON CONFLICT DO NOTHING;

-- amy (ant / content)
INSERT INTO creature_skills (creature_id, skill_name, added_by)
SELECT e.id, s.skill_name, 'seed'
FROM entities e
CROSS JOIN (VALUES
  ('forest'), ('memory'), ('briefing'), ('google-workspace'),
  ('plane'), ('content'), ('miro'), ('obsidian'), ('browser'),
  ('research'), ('analytics'), ('agentmail'), ('agent-memory')
) AS s(skill_name)
WHERE e.name = 'amy'
ON CONFLICT DO NOTHING;

-- brian (owl / critic)
INSERT INTO creature_skills (creature_id, skill_name, added_by)
SELECT e.id, s.skill_name, 'seed'
FROM entities e
CROSS JOIN (VALUES
  ('forest'), ('memory'), ('briefing'), ('plane'), ('critique'),
  ('quality-review'), ('architecture-review'), ('verify'), ('audit'),
  ('agent-memory')
) AS s(skill_name)
WHERE e.name = 'brian'
ON CONFLICT DO NOTHING;

-- alan (bird / strategy)
INSERT INTO creature_skills (creature_id, skill_name, added_by)
SELECT e.id, s.skill_name, 'seed'
FROM entities e
CROSS JOIN (VALUES
  ('forest'), ('memory'), ('briefing'), ('google-workspace'),
  ('miro'), ('plane'), ('research'), ('strategy'), ('context-strategy'),
  ('analytics'), ('obsidian'), ('meeting-prep'), ('agent-memory')
) AS s(skill_name)
WHERE e.name = 'alan'
ON CONFLICT DO NOTHING;

-- kate (squirrel / research)
INSERT INTO creature_skills (creature_id, skill_name, added_by)
SELECT e.id, s.skill_name, 'seed'
FROM entities e
CROSS JOIN (VALUES
  ('forest'), ('memory'), ('briefing'), ('google-workspace'),
  ('browser'), ('research'), ('miro'), ('obsidian'), ('plane'),
  ('analytics'), ('relationship-tracker'), ('agent-memory')
) AS s(skill_name)
WHERE e.name = 'kate'
ON CONFLICT DO NOTHING;

-- marcus (ant / finance)
INSERT INTO creature_skills (creature_id, skill_name, added_by)
SELECT e.id, s.skill_name, 'seed'
FROM entities e
CROSS JOIN (VALUES
  ('forest'), ('memory'), ('briefing'), ('google-workspace'),
  ('finance'), ('plane'), ('analytics'), ('ellie-reports'), ('obsidian'),
  ('agent-memory')
) AS s(skill_name)
WHERE e.name = 'marcus'
ON CONFLICT DO NOTHING;

-- jason (ant / ops)
INSERT INTO creature_skills (creature_id, skill_name, added_by)
SELECT e.id, s.skill_name, 'seed'
FROM entities e
CROSS JOIN (VALUES
  ('forest'), ('memory'), ('briefing'), ('plane'), ('ops'),
  ('docker'), ('github'), ('alert'), ('audit'), ('analytics'),
  ('n8n'), ('automation-workflows'), ('verify'), ('google-workspace'),
  ('agent-memory')
) AS s(skill_name)
WHERE e.name = 'jason'
ON CONFLICT DO NOTHING;

-- ============================================================
-- Part 3: Archetype-based agents (no config, infer from name)
-- ============================================================

-- dev_agent / dev_agent_v1 — dev archetype skills
INSERT INTO creature_skills (creature_id, skill_name, added_by)
SELECT e.id, s.skill_name, 'seed'
FROM entities e
CROSS JOIN (VALUES
  ('github'), ('plane'), ('forest'), ('memory'), ('briefing'),
  ('google-workspace'), ('miro'), ('architecture-review'), ('audit'),
  ('docker'), ('obsidian'), ('verify'), ('browser'), ('quality-review')
) AS s(skill_name)
WHERE e.name IN ('dev_agent', 'dev_agent_v1')
ON CONFLICT DO NOTHING;

-- research_agent / research_agent_v1 — research archetype skills
INSERT INTO creature_skills (creature_id, skill_name, added_by)
SELECT e.id, s.skill_name, 'seed'
FROM entities e
CROSS JOIN (VALUES
  ('forest'), ('memory'), ('briefing'), ('google-workspace'),
  ('browser'), ('research'), ('miro'), ('obsidian'), ('plane'),
  ('analytics'), ('relationship-tracker')
) AS s(skill_name)
WHERE e.name IN ('research_agent', 'research_agent_v1')
ON CONFLICT DO NOTHING;

-- finance_agent / finance_agent_v1 — finance archetype skills
INSERT INTO creature_skills (creature_id, skill_name, added_by)
SELECT e.id, s.skill_name, 'seed'
FROM entities e
CROSS JOIN (VALUES
  ('forest'), ('memory'), ('briefing'), ('google-workspace'),
  ('finance'), ('plane'), ('analytics'), ('ellie-reports'), ('obsidian')
) AS s(skill_name)
WHERE e.name IN ('finance_agent', 'finance_agent_v1')
ON CONFLICT DO NOTHING;

-- general_agent / general_agent_v1 — general archetype skills
INSERT INTO creature_skills (creature_id, skill_name, added_by)
SELECT e.id, s.skill_name, 'seed'
FROM entities e
CROSS JOIN (VALUES
  ('forest'), ('memory'), ('briefing'), ('google-workspace'),
  ('plane'), ('calendar-intel'), ('comms'), ('agentmail'), ('alert'),
  ('analytics'), ('daily-briefing'), ('gtd'), ('browser'), ('weather'),
  ('meeting-prep'), ('relationship-tracker')
) AS s(skill_name)
WHERE e.name IN ('general_agent', 'general_agent_v1')
ON CONFLICT DO NOTHING;

-- critic_agent / critic_agent_v1 — critic archetype skills
INSERT INTO creature_skills (creature_id, skill_name, added_by)
SELECT e.id, s.skill_name, 'seed'
FROM entities e
CROSS JOIN (VALUES
  ('forest'), ('memory'), ('briefing'), ('plane'), ('critique'),
  ('quality-review'), ('architecture-review'), ('verify'), ('audit')
) AS s(skill_name)
WHERE e.name IN ('critic_agent', 'critic_agent_v1')
ON CONFLICT DO NOTHING;

-- content_agent / content_agent_v1 — content archetype skills
INSERT INTO creature_skills (creature_id, skill_name, added_by)
SELECT e.id, s.skill_name, 'seed'
FROM entities e
CROSS JOIN (VALUES
  ('forest'), ('memory'), ('briefing'), ('google-workspace'),
  ('plane'), ('content'), ('miro'), ('obsidian'), ('browser'),
  ('research'), ('analytics'), ('agentmail')
) AS s(skill_name)
WHERE e.name IN ('content_agent', 'content_agent_v1')
ON CONFLICT DO NOTHING;

-- strategy_agent / strategy_agent_v1 — strategy archetype skills
INSERT INTO creature_skills (creature_id, skill_name, added_by)
SELECT e.id, s.skill_name, 'seed'
FROM entities e
CROSS JOIN (VALUES
  ('forest'), ('memory'), ('briefing'), ('google-workspace'),
  ('miro'), ('plane'), ('research'), ('strategy'), ('context-strategy'),
  ('analytics'), ('obsidian'), ('meeting-prep')
) AS s(skill_name)
WHERE e.name IN ('strategy_agent', 'strategy_agent_v1')
ON CONFLICT DO NOTHING;

-- ops_agent — ops archetype skills
INSERT INTO creature_skills (creature_id, skill_name, added_by)
SELECT e.id, s.skill_name, 'seed'
FROM entities e
CROSS JOIN (VALUES
  ('forest'), ('memory'), ('briefing'), ('plane'), ('ops'),
  ('docker'), ('github'), ('alert'), ('audit'), ('analytics'),
  ('n8n'), ('automation-workflows'), ('verify'), ('google-workspace')
) AS s(skill_name)
WHERE e.name = 'ops_agent'
ON CONFLICT DO NOTHING;

-- agent_router_v1 — minimal routing skill set
INSERT INTO creature_skills (creature_id, skill_name, added_by)
SELECT e.id, s.skill_name, 'seed'
FROM entities e
CROSS JOIN (VALUES
  ('forest'), ('memory'), ('briefing'), ('plane')
) AS s(skill_name)
WHERE e.name = 'agent_router_v1'
ON CONFLICT DO NOTHING;
