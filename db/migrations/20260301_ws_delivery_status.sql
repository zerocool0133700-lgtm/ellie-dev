-- ELLIE-399: WebSocket delivery tracking columns
-- Adds delivery_status and sent_at to messages table for disconnect recovery

ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_status TEXT DEFAULT 'pending';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

-- Add check constraint (idempotent via DO block)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'messages_delivery_status_check'
  ) THEN
    ALTER TABLE messages ADD CONSTRAINT messages_delivery_status_check
      CHECK (delivery_status IN ('pending', 'sent', 'failed', 'fallback'));
  END IF;
END $$;

-- Partial index for catch-up queries (only index non-sent rows)
CREATE INDEX IF NOT EXISTS idx_messages_delivery_status
  ON messages(delivery_status) WHERE delivery_status != 'sent';
