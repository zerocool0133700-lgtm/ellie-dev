-- ELLIE-400: Command bar configuration columns
-- Adds context_priority for controlling prompt section priority per channel
-- Adds is_command_bar flag to distinguish inline command bar channels from sidebar channels

ALTER TABLE chat_channels
  ADD COLUMN IF NOT EXISTS context_priority INTEGER DEFAULT 2,
  ADD COLUMN IF NOT EXISTS is_command_bar BOOLEAN DEFAULT FALSE;

-- Mark the forest-editor channel as a command bar
UPDATE chat_channels
SET is_command_bar = true
WHERE id = 'a0000000-0000-0000-0000-000000000100';
