-- ELLIE-847: Agent Identity — avatar colors and display metadata

ALTER TABLE agents ADD COLUMN IF NOT EXISTS color TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- Seed colors for each agent
UPDATE agents SET color = '#06B6D4' WHERE name = 'general';  -- Ellie: cyan
UPDATE agents SET color = '#3B82F6' WHERE name = 'dev';       -- James: blue
UPDATE agents SET color = '#8B5CF6' WHERE name = 'research';  -- Kate: violet
UPDATE agents SET color = '#EC4899' WHERE name = 'content';   -- Amy: pink
UPDATE agents SET color = '#F59E0B' WHERE name = 'critic';    -- Brian: amber
UPDATE agents SET color = '#10B981' WHERE name = 'strategy';  -- Alan: emerald
UPDATE agents SET color = '#EF4444' WHERE name = 'ops';       -- Jason: red
