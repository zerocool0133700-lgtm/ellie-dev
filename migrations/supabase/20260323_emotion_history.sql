-- Emotion timeline tracking for EI detection (ELLIE-xxx)
-- Stores detected emotions across conversation turns for temporal analysis

CREATE TABLE IF NOT EXISTS emotion_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  conversation_id UUID,
  channel TEXT NOT NULL,
  turn_number INT,

  -- Detected emotion data
  emotion TEXT NOT NULL,
  intensity FLOAT NOT NULL CHECK (intensity >= 0 AND intensity <= 1),
  empathy_score FLOAT CHECK (empathy_score >= 0 AND empathy_score <= 1),

  -- Message context
  message_text TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for temporal queries
CREATE INDEX idx_emotion_history_user_time ON emotion_history(user_id, created_at DESC);
CREATE INDEX idx_emotion_history_conversation ON emotion_history(conversation_id, turn_number);

-- RLS policies
ALTER TABLE emotion_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read their own emotion history"
  ON emotion_history FOR SELECT
  USING (TRUE); -- Public read for now; tighten in production

CREATE POLICY "Service can insert emotion history"
  ON emotion_history FOR INSERT
  WITH CHECK (TRUE); -- Service role inserts

COMMENT ON TABLE emotion_history IS 'Temporal emotion tracking for EI detection — tracks emotion states across conversation turns';
