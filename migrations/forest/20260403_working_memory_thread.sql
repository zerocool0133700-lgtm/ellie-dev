-- Add thread_id to working_memory for thread-scoped isolation — ELLIE-1374
ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS thread_id TEXT;
CREATE INDEX IF NOT EXISTS idx_working_memory_thread ON working_memory(thread_id) WHERE thread_id IS NOT NULL;
