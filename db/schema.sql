-- Supabase Schema for Persistent Memory
-- Run this in Supabase SQL Editor (or via Supabase MCP)
-- This enables: conversation history, semantic search, goals tracking
--
-- After running this, set up the embed Edge Function and database webhook
-- so embeddings are generated automatically on every INSERT.

-- Required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ============================================================
-- CONVERSATIONS TABLE (Groups messages into sessions)
-- ============================================================
CREATE TABLE IF NOT EXISTS conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  channel TEXT NOT NULL DEFAULT 'telegram',
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'closed', 'expired')),
  agent TEXT DEFAULT 'general',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,
  summary TEXT,
  message_count INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_conversations_started_at ON conversations(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations(channel);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_conversations_channel_status ON conversations(channel, status);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at ON conversations(last_message_at DESC);

-- ============================================================
-- MESSAGES TABLE (Conversation History)
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  channel TEXT DEFAULT 'telegram',
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(1536), -- For semantic search (optional)
  summarized BOOLEAN DEFAULT FALSE,
  conversation_id UUID REFERENCES conversations(id),
  delivery_status TEXT DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'sent', 'failed', 'fallback')),
  external_id TEXT, -- Platform message ID (gchat resource name or telegram message_id)
  sent_at TIMESTAMPTZ,
  delivery_channel TEXT -- Actual channel delivered on (may differ from channel if fallback used)
);

CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
CREATE INDEX IF NOT EXISTS idx_messages_summarized ON messages(summarized) WHERE summarized = FALSE;
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_delivery_status ON messages(delivery_status) WHERE delivery_status != 'sent';

-- ============================================================
-- MEMORY TABLE (Facts & Goals)
-- ============================================================
CREATE TABLE IF NOT EXISTS memory (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  type TEXT NOT NULL CHECK (type IN ('fact', 'goal', 'completed_goal', 'preference', 'summary', 'action_item')),
  content TEXT NOT NULL,
  deadline TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  priority INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  embedding VECTOR(1536),
  conversation_id UUID REFERENCES conversations(id)
);

CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type);
CREATE INDEX IF NOT EXISTS idx_memory_created_at ON memory(created_at DESC);

-- ============================================================
-- LOGS TABLE (Observability - Optional)
-- ============================================================
CREATE TABLE IF NOT EXISTS logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  level TEXT DEFAULT 'info' CHECK (level IN ('debug', 'info', 'warn', 'error')),
  event TEXT NOT NULL,
  message TEXT,
  metadata JSONB DEFAULT '{}',
  session_id TEXT,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE logs ENABLE ROW LEVEL SECURITY;

-- Allow all for service role (your bot uses service key)
CREATE POLICY "Allow all for service role" ON conversations FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON messages FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON memory FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON logs FOR ALL USING (true);

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

-- Get recent messages for context
CREATE OR REPLACE FUNCTION get_recent_messages(limit_count INTEGER DEFAULT 20)
RETURNS TABLE (
  id UUID,
  created_at TIMESTAMPTZ,
  role TEXT,
  content TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.created_at, m.role, m.content
  FROM messages m
  ORDER BY m.created_at DESC
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- Get active goals
CREATE OR REPLACE FUNCTION get_active_goals()
RETURNS TABLE (
  id UUID,
  content TEXT,
  deadline TIMESTAMPTZ,
  priority INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.content, m.deadline, m.priority
  FROM memory m
  WHERE m.type = 'goal'
  ORDER BY m.priority DESC, m.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Get all facts
CREATE OR REPLACE FUNCTION get_facts()
RETURNS TABLE (
  id UUID,
  content TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.content
  FROM memory m
  WHERE m.type = 'fact'
  ORDER BY m.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Get or create active conversation for a channel
CREATE OR REPLACE FUNCTION get_or_create_conversation(
  p_channel TEXT,
  p_agent TEXT DEFAULT 'general',
  p_idle_minutes INTEGER DEFAULT 30
)
RETURNS UUID AS $$
DECLARE
  v_conversation_id UUID;
  v_last_message_at TIMESTAMPTZ;
BEGIN
  SELECT id, last_message_at INTO v_conversation_id, v_last_message_at
  FROM conversations
  WHERE channel = p_channel AND status = 'active'
  ORDER BY started_at DESC
  LIMIT 1;

  IF v_conversation_id IS NOT NULL AND v_last_message_at IS NOT NULL
     AND (NOW() - v_last_message_at) > (p_idle_minutes || ' minutes')::INTERVAL THEN
    UPDATE conversations
    SET status = 'expired', ended_at = v_last_message_at, closed_at = NOW()
    WHERE id = v_conversation_id;
    v_conversation_id := NULL;
  END IF;

  IF v_conversation_id IS NULL THEN
    INSERT INTO conversations (channel, agent, status, started_at, last_message_at, message_count)
    VALUES (p_channel, p_agent, 'active', NOW(), NOW(), 0)
    RETURNING id INTO v_conversation_id;
  END IF;

  RETURN v_conversation_id;
END;
$$ LANGUAGE plpgsql;

-- Close a conversation
CREATE OR REPLACE FUNCTION close_conversation(
  p_conversation_id UUID,
  p_summary TEXT DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
  UPDATE conversations
  SET status = 'closed',
      ended_at = last_message_at,
      closed_at = NOW(),
      summary = COALESCE(p_summary, summary)
  WHERE id = p_conversation_id AND status = 'active';
END;
$$ LANGUAGE plpgsql;

-- Expire idle conversations
CREATE OR REPLACE FUNCTION expire_idle_conversations(
  p_idle_minutes INTEGER DEFAULT 30
)
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE conversations
  SET status = 'expired', ended_at = last_message_at, closed_at = NOW()
  WHERE status = 'active'
    AND last_message_at < NOW() - (p_idle_minutes || ' minutes')::INTERVAL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- Get conversation context for classifier
CREATE OR REPLACE FUNCTION get_conversation_context(p_channel TEXT)
RETURNS TABLE (
  conversation_id UUID,
  agent TEXT,
  summary TEXT,
  message_count INTEGER,
  started_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT c.id, c.agent, c.summary, c.message_count, c.started_at, c.last_message_at
  FROM conversations c
  WHERE c.channel = p_channel AND c.status = 'active'
  ORDER BY c.started_at DESC
  LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- SEMANTIC SEARCH
-- ============================================================
-- Embeddings are generated automatically by the embed Edge Function
-- via database webhook. The search Edge Function calls these RPCs.

-- Match messages by embedding similarity
CREATE OR REPLACE FUNCTION match_messages(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  role TEXT,
  created_at TIMESTAMPTZ,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.role,
    m.created_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM messages m
  WHERE m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- Match memory entries by embedding similarity
CREATE OR REPLACE FUNCTION match_memory(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  type TEXT,
  created_at TIMESTAMPTZ,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.content,
    m.type,
    m.created_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM memory m
  WHERE m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- WORK SESSIONS TABLE (Claude Code dispatch protocol)
-- ============================================================
CREATE TABLE IF NOT EXISTS work_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  work_item_id TEXT NOT NULL,
  work_item_title TEXT NOT NULL,
  project TEXT NOT NULL,
  agent TEXT,
  state TEXT DEFAULT 'active' CHECK (state IN ('active', 'blocked', 'completed')),
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_work_sessions_created_at ON work_sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_sessions_work_item_id ON work_sessions(work_item_id);
CREATE INDEX IF NOT EXISTS idx_work_sessions_state ON work_sessions(state);

-- ============================================================
-- WORK SESSION UPDATES TABLE (Progress tracking)
-- ============================================================
CREATE TABLE IF NOT EXISTS work_session_updates (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  session_id UUID REFERENCES work_sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('progress', 'decision', 'blocker')),
  message TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_work_session_updates_session_id ON work_session_updates(session_id);
CREATE INDEX IF NOT EXISTS idx_work_session_updates_created_at ON work_session_updates(created_at DESC);

-- RLS for work sessions
ALTER TABLE work_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_session_updates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON work_sessions FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON work_session_updates FOR ALL USING (true);

-- ============================================================
-- PEOPLE TABLE (Global entities — shared across chains)
-- ============================================================
CREATE TABLE IF NOT EXISTS people (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  relationship_type TEXT NOT NULL DEFAULT 'other',
  notes TEXT,
  contact_methods JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_people_name ON people(name);
CREATE INDEX IF NOT EXISTS idx_people_relationship_type ON people(relationship_type);

-- ============================================================
-- GROUPS TABLE (Chain-scoped by owner_id)
-- ============================================================
CREATE TABLE IF NOT EXISTS groups (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  default_model TEXT,
  metadata JSONB DEFAULT '{}',
  owner_id UUID NOT NULL REFERENCES people(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_groups_owner_id ON groups(owner_id);
CREATE INDEX IF NOT EXISTS idx_groups_name ON groups(name);

-- ============================================================
-- GROUP MEMBERSHIPS TABLE (Chain-scoped by owner_id)
-- ============================================================
CREATE TABLE IF NOT EXISTS group_memberships (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES people(id),
  role TEXT DEFAULT 'member',
  access_level TEXT DEFAULT 'full',
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, person_id)
);

CREATE INDEX IF NOT EXISTS idx_group_memberships_group_id ON group_memberships(group_id);
CREATE INDEX IF NOT EXISTS idx_group_memberships_person_id ON group_memberships(person_id);
CREATE INDEX IF NOT EXISTS idx_group_memberships_owner_id ON group_memberships(owner_id);

-- RLS for groups/people/memberships
ALTER TABLE people ENABLE ROW LEVEL SECURITY;
ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_memberships ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON people FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON groups FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON group_memberships FOR ALL USING (true);

-- ============================================================
-- SKILLS TABLE (Agent skill registry for intent routing)
-- ============================================================
CREATE TABLE IF NOT EXISTS skills (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Ownership
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES people(id),

  -- Identity
  name TEXT NOT NULL,
  description TEXT NOT NULL,

  -- Matching
  triggers TEXT[] DEFAULT '{}',
  requires_tools TEXT[] DEFAULT '{}',
  requires_confirm BOOLEAN DEFAULT FALSE,

  -- Configuration
  parameters JSONB DEFAULT '{}',
  output_schema JSONB DEFAULT NULL,
  complexity TEXT DEFAULT 'heavy' CHECK (complexity IN ('light', 'heavy')),
  enabled BOOLEAN DEFAULT TRUE,
  priority INTEGER DEFAULT 0,

  UNIQUE(owner_id, name)
);

CREATE INDEX IF NOT EXISTS idx_skills_agent_id ON skills(agent_id);
CREATE INDEX IF NOT EXISTS idx_skills_owner_id ON skills(owner_id);
CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled) WHERE enabled = TRUE;
CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);

ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON skills FOR ALL USING (true);

-- ============================================================
-- EXECUTION PLANS TABLE (Multi-step execution tracking)
-- ============================================================
CREATE TABLE IF NOT EXISTS execution_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID REFERENCES conversations(id),
  mode TEXT NOT NULL CHECK (mode IN ('single', 'pipeline', 'fan-out', 'critic-loop')),
  original_message TEXT,
  steps JSONB NOT NULL DEFAULT '[]',
  total_tokens INTEGER DEFAULT 0,
  total_cost_usd NUMERIC(10,6) DEFAULT 0,
  status TEXT DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'partial')),
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_execution_plans_conversation_id ON execution_plans(conversation_id);
CREATE INDEX IF NOT EXISTS idx_execution_plans_status ON execution_plans(status);
CREATE INDEX IF NOT EXISTS idx_execution_plans_created_at ON execution_plans(created_at DESC);

ALTER TABLE execution_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all for service role" ON execution_plans FOR ALL USING (true);

-- Enable realtime for groups/people
ALTER PUBLICATION supabase_realtime ADD TABLE groups;
ALTER PUBLICATION supabase_realtime ADD TABLE people;
ALTER PUBLICATION supabase_realtime ADD TABLE group_memberships;
