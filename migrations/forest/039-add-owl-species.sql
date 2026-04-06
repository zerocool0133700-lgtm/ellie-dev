-- Add 'owl' to agent_species enum
-- Brian (Critic) is an owl species per archetype definition

ALTER TYPE agent_species ADD VALUE IF NOT EXISTS 'owl';
