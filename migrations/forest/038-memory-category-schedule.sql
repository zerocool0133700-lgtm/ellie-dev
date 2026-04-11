-- Migration 038: Add 'schedule' to memory_category enum
-- The memory classifier returns 'schedule' as a valid category, but the enum was missing it.
-- This caused tests and Forest syncs to fail with constraint violations.

-- PostgreSQL doesn't support direct ALTER TYPE ... ADD VALUE with IF NOT EXISTS.
-- We must use a transaction with a check to avoid re-applying.

DO $$ BEGIN
  -- Check if 'schedule' already exists in the enum
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'schedule'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'memory_category')
  ) THEN
    -- Add 'schedule' to the enum (placed logically before other life categories)
    ALTER TYPE memory_category ADD VALUE 'schedule' BEFORE 'spirituality';
    RAISE NOTICE 'Added schedule to memory_category enum';
  ELSE
    RAISE NOTICE 'schedule already exists in memory_category enum';
  END IF;
END $$;
