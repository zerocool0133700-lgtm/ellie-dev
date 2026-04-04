-- ELLIE-1426: Add partial index on conversation_facts for active status queries
-- This is the most common query pattern (loadSessionContextFromConversationFacts, fact extraction)
CREATE INDEX IF NOT EXISTS idx_conversation_facts_status_active
  ON conversation_facts (created_at DESC)
  WHERE status = 'active';
