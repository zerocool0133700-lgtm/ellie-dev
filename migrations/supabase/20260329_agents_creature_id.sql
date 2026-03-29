ALTER TABLE agents ADD COLUMN IF NOT EXISTS creature_id UUID;

COMMENT ON COLUMN agents.creature_id IS 'Logical FK to Forest DB entities table — resolved at runtime via ellie-forest library';
