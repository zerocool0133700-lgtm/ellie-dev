-- ELLIE-70: Backfill NULL source_agent values with 'general'
-- This fixes pre-migration memory rows that were created before source_agent was added

-- Update all NULL source_agent rows to 'general' (the default agent)
UPDATE memory
SET source_agent = 'general'
WHERE source_agent IS NULL;

-- Ensure future rows cannot have NULL source_agent
ALTER TABLE memory
  ALTER COLUMN source_agent SET DEFAULT 'general';
