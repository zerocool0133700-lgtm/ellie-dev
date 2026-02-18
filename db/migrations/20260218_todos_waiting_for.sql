-- ELLIE-39: Add 'waiting_for' status to todos
-- Run against Supabase SQL editor

-- Add waiting_on column for tracking who/what is blocking
ALTER TABLE todos ADD COLUMN IF NOT EXISTS waiting_on TEXT;

-- Update status check constraint to include waiting_for
ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_status_check;
ALTER TABLE todos ADD CONSTRAINT todos_status_check
  CHECK (status IN ('open', 'done', 'cancelled', 'waiting_for'));
