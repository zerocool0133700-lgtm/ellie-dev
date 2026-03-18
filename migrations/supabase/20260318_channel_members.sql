-- ELLIE-842: Channel Members — join table for channel participation
--
-- Informational membership (no access control enforcement).
-- Used for @mention autocomplete, participant lists, presence display.

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id UUID REFERENCES chat_channels(id) ON DELETE CASCADE,
  member_type TEXT NOT NULL CHECK (member_type IN ('user', 'agent')),
  member_id TEXT NOT NULL,
  display_name TEXT,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (channel_id, member_type, member_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_members_member
  ON channel_members(member_type, member_id);

-- Seed Dave into all top-level channels
INSERT INTO channel_members (channel_id, member_type, member_id, display_name)
SELECT id, 'user', 'dave', 'Dave'
FROM chat_channels WHERE parent_id IS NULL
ON CONFLICT DO NOTHING;

-- Seed all 7 agents into General channel
INSERT INTO channel_members (channel_id, member_type, member_id, display_name)
VALUES
  ('a0000000-0000-0000-0000-000000000001', 'agent', 'general', 'Ellie'),
  ('a0000000-0000-0000-0000-000000000001', 'agent', 'dev', 'James'),
  ('a0000000-0000-0000-0000-000000000001', 'agent', 'research', 'Kate'),
  ('a0000000-0000-0000-0000-000000000001', 'agent', 'content', 'Amy'),
  ('a0000000-0000-0000-0000-000000000001', 'agent', 'critic', 'Brian'),
  ('a0000000-0000-0000-0000-000000000001', 'agent', 'strategy', 'Alan'),
  ('a0000000-0000-0000-0000-000000000001', 'agent', 'ops', 'Jason')
ON CONFLICT DO NOTHING;

-- Seed role-specific agents into relevant channels
-- James (dev) → Deep Work
INSERT INTO channel_members (channel_id, member_type, member_id, display_name)
VALUES ('a0000000-0000-0000-0000-000000000003', 'agent', 'dev', 'James')
ON CONFLICT DO NOTHING;

-- Kate (research) → Strategy + sub-channels
INSERT INTO channel_members (channel_id, member_type, member_id, display_name)
VALUES
  ('a0000000-0000-0000-0000-000000000002', 'agent', 'research', 'Kate'),
  ('a0000000-0000-0000-0000-000000000010', 'agent', 'research', 'Kate'),
  ('a0000000-0000-0000-0000-000000000011', 'agent', 'research', 'Kate')
ON CONFLICT DO NOTHING;

-- Alan (strategy) → Strategy + sub-channels
INSERT INTO channel_members (channel_id, member_type, member_id, display_name)
VALUES
  ('a0000000-0000-0000-0000-000000000002', 'agent', 'strategy', 'Alan'),
  ('a0000000-0000-0000-0000-000000000010', 'agent', 'strategy', 'Alan'),
  ('a0000000-0000-0000-0000-000000000011', 'agent', 'strategy', 'Alan'),
  ('a0000000-0000-0000-0000-000000000012', 'agent', 'strategy', 'Alan')
ON CONFLICT DO NOTHING;

-- Brian (critic) → all channels (read access everywhere)
INSERT INTO channel_members (channel_id, member_type, member_id, display_name)
SELECT id, 'agent', 'critic', 'Brian'
FROM chat_channels
ON CONFLICT DO NOTHING;

-- Jason (ops) → Ops + sub-channels
INSERT INTO channel_members (channel_id, member_type, member_id, display_name)
VALUES
  ('a0000000-0000-0000-0000-000000000004', 'agent', 'ops', 'Jason'),
  ('a0000000-0000-0000-0000-000000000020', 'agent', 'ops', 'Jason'),
  ('a0000000-0000-0000-0000-000000000021', 'agent', 'ops', 'Jason')
ON CONFLICT DO NOTHING;

-- Ellie (general) → all channels
INSERT INTO channel_members (channel_id, member_type, member_id, display_name)
SELECT id, 'agent', 'general', 'Ellie'
FROM chat_channels
ON CONFLICT DO NOTHING;
