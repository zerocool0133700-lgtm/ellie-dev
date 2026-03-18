-- ELLIE-854: Channel Read State — per-user per-channel read tracking

CREATE TABLE IF NOT EXISTS channel_read_state (
  channel_id UUID REFERENCES chat_channels(id) ON DELETE CASCADE,
  reader_type TEXT NOT NULL CHECK (reader_type IN ('user', 'agent')),
  reader_id TEXT NOT NULL,
  last_read_at TIMESTAMPTZ DEFAULT NOW(),
  last_read_message_id UUID REFERENCES messages(id),
  PRIMARY KEY (channel_id, reader_type, reader_id)
);
