-- Add 'pattern' to the memory_type enum
-- Fixes: forest memory writes with type "pattern" were failing with PostgresError
ALTER TYPE memory_type ADD VALUE IF NOT EXISTS 'pattern';
