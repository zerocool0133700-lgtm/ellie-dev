-- Agent Framework Infrastructure Migration
-- ELLIE-6: Multi-agent orchestration and intelligent routing

-- ============================================================
-- AGENTS TABLE (Agent Registry)
-- ============================================================
CREATE TABLE IF NOT EXISTS agents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Agent Identity
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('general', 'dev', 'research', 'content', 'finance', 'strategy', 'critic')),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'maintenance')),

  -- Capabilities & Configuration
  capabilities TEXT[] DEFAULT '{}',
  model TEXT DEFAULT 'claude-sonnet-4-5-20250929',
  tools_enabled TEXT[] DEFAULT '{}',
  system_prompt TEXT,

  -- Performance Tracking
  total_sessions INTEGER DEFAULT 0,
  successful_sessions INTEGER DEFAULT 0,
  failed_sessions INTEGER DEFAULT 0,
  avg_response_time_ms INTEGER,

  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);
CREATE INDEX IF NOT EXISTS idx_agents_type ON agents(type);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);

-- ============================================================
-- AGENT_SESSIONS TABLE (Work Session Tracking)
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  -- Agent & User
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT 'telegram',
  work_item_id TEXT,
  work_item_title TEXT,

  -- Session State
  state TEXT DEFAULT 'active' CHECK (state IN ('active', 'blocked', 'completed', 'failed', 'handed_off')),
  priority INTEGER DEFAULT 0,
  turn_count INTEGER DEFAULT 0,
  last_activity TIMESTAMPTZ DEFAULT NOW(),

  -- Context & Performance
  context_summary TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  duration_ms INTEGER,

  -- Parent/Child Sessions (for handoffs)
  parent_session_id UUID REFERENCES agent_sessions(id),

  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent_id ON agent_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_state ON agent_sessions(state);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_created_at ON agent_sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_work_item_id ON agent_sessions(work_item_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_parent_session_id ON agent_sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_active ON agent_sessions(user_id, channel, state)
  WHERE state = 'active';

-- ============================================================
-- AGENT_MESSAGES TABLE (Session Communication Log)
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  session_id UUID REFERENCES agent_sessions(id) ON DELETE CASCADE,

  -- Message Details
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL,
  tool_calls JSONB,
  tool_results JSONB,

  -- Performance
  tokens INTEGER DEFAULT 0,
  duration_ms INTEGER,

  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_session_id ON agent_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_messages_created_at ON agent_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_messages_role ON agent_messages(role);

-- ============================================================
-- ROUTING_RULES TABLE (Intelligent Message Routing)
-- ============================================================
CREATE TABLE IF NOT EXISTS routing_rules (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Rule Definition
  name TEXT NOT NULL,
  description TEXT,
  priority INTEGER DEFAULT 0,
  enabled BOOLEAN DEFAULT TRUE,

  -- Matching Criteria (JSONPath or pattern matching)
  conditions JSONB NOT NULL,

  -- Target Agent
  target_agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,

  -- Performance Tracking
  match_count INTEGER DEFAULT 0,
  last_matched_at TIMESTAMPTZ,

  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_routing_rules_priority ON routing_rules(priority DESC);
CREATE INDEX IF NOT EXISTS idx_routing_rules_enabled ON routing_rules(enabled) WHERE enabled = TRUE;
CREATE INDEX IF NOT EXISTS idx_routing_rules_target_agent_id ON routing_rules(target_agent_id);

-- ============================================================
-- AGENT_HANDOFFS TABLE (Cross-Agent Coordination)
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_handoffs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  -- Source & Target
  from_agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  to_agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  from_session_id UUID REFERENCES agent_sessions(id) ON DELETE CASCADE,
  to_session_id UUID REFERENCES agent_sessions(id),

  -- Handoff Details
  reason TEXT NOT NULL,
  state TEXT DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'rejected', 'completed')),
  context_summary TEXT,

  -- Approval Workflow (optional)
  requires_approval BOOLEAN DEFAULT FALSE,
  approved_by TEXT,
  approved_at TIMESTAMPTZ,

  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_agent_handoffs_from_agent_id ON agent_handoffs(from_agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_handoffs_to_agent_id ON agent_handoffs(to_agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_handoffs_state ON agent_handoffs(state);
CREATE INDEX IF NOT EXISTS idx_agent_handoffs_created_at ON agent_handoffs(created_at DESC);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_handoffs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for service role" ON agents FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON agent_sessions FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON agent_messages FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON routing_rules FOR ALL USING (true);
CREATE POLICY "Allow all for service role" ON agent_handoffs FOR ALL USING (true);

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

-- Get active agent sessions
CREATE OR REPLACE FUNCTION get_active_agent_sessions(p_agent_name TEXT DEFAULT NULL)
RETURNS TABLE (
  session_id UUID,
  agent TEXT,
  work_item_id TEXT,
  work_item_title TEXT,
  session_state TEXT,
  session_created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.id,
    a.name,
    s.work_item_id,
    s.work_item_title,
    s.state,
    s.created_at
  FROM agent_sessions s
  JOIN agents a ON s.agent_id = a.id
  WHERE s.state IN ('active', 'blocked')
    AND (p_agent_name IS NULL OR a.name = p_agent_name)
  ORDER BY s.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- Route message to appropriate agent
CREATE OR REPLACE FUNCTION route_message(
  p_message_content TEXT,
  p_message_metadata JSONB DEFAULT '{}'
)
RETURNS TABLE (
  matched_agent_id UUID,
  matched_agent_name TEXT,
  matched_rule_name TEXT
) AS $$
BEGIN
  -- Placeholder — actual routing logic in the route-message Edge Function
  RETURN QUERY
  SELECT
    a.id,
    a.name,
    r.name
  FROM routing_rules r
  JOIN agents a ON r.target_agent_id = a.id
  WHERE r.enabled = TRUE
  ORDER BY r.priority DESC
  LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- Get agent performance stats
CREATE OR REPLACE FUNCTION get_agent_stats(p_agent_name TEXT)
RETURNS TABLE (
  total_sessions INTEGER,
  successful_sessions INTEGER,
  failed_sessions INTEGER,
  success_rate FLOAT,
  avg_duration_ms FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::INTEGER AS total_sessions,
    COUNT(*) FILTER (WHERE s.state = 'completed')::INTEGER AS successful_sessions,
    COUNT(*) FILTER (WHERE s.state = 'failed')::INTEGER AS failed_sessions,
    (COUNT(*) FILTER (WHERE s.state = 'completed')::FLOAT / NULLIF(COUNT(*), 0)) AS success_rate,
    AVG(s.duration_ms) AS avg_duration_ms
  FROM agent_sessions s
  JOIN agents a ON s.agent_id = a.id
  WHERE a.name = p_agent_name;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- SEED DATA (Default Agents)
-- ============================================================
INSERT INTO agents (name, type, capabilities, system_prompt) VALUES
  ('general', 'general', ARRAY['conversation', 'task-management', 'coordination'],
   'You are a general-purpose AI assistant. Coordinate with specialized agents when needed.'),

  ('dev', 'dev', ARRAY['coding', 'debugging', 'git', 'deployment'],
   'You are a software development specialist. Handle code implementation, debugging, and deployment tasks.'),

  ('research', 'research', ARRAY['web-search', 'analysis', 'summarization'],
   'You are a research specialist. Gather information, analyze data, and provide comprehensive summaries.'),

  ('content', 'content', ARRAY['writing', 'editing', 'documentation'],
   'You are a content creation specialist. Handle writing, editing, and documentation tasks.'),

  ('finance', 'finance', ARRAY['budgeting', 'analysis', 'reporting'],
   'You are a financial analysis specialist. Handle budgets, financial reports, and data analysis.'),

  ('strategy', 'strategy', ARRAY['planning', 'decision-making', 'roadmapping'],
   'You are a strategic planning specialist. Help with long-term planning and decision-making.'),

  ('critic', 'critic', ARRAY['review', 'feedback', 'quality-assurance'],
   'You are a critical reviewer. Provide constructive feedback and identify potential issues.')
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- SEED DATA (Default Routing Rules)
-- ============================================================

-- Research agent
INSERT INTO routing_rules (name, description, priority, conditions, target_agent_id)
SELECT 'research_keywords', 'Route research-related queries to research agent', 10,
  '{"keywords": ["research", "find out", "investigate", "look up", "search for"]}'::jsonb,
  id FROM agents WHERE name = 'research';

-- Dev agent
INSERT INTO routing_rules (name, description, priority, conditions, target_agent_id)
SELECT 'dev_keywords', 'Route coding tasks to dev agent', 10,
  '{"keywords": ["code", "debug", "implement", "refactor", "fix bug", "deploy"]}'::jsonb,
  id FROM agents WHERE name = 'dev';

-- Finance agent
INSERT INTO routing_rules (name, description, priority, conditions, target_agent_id)
SELECT 'finance_keywords', 'Route financial queries to finance agent', 10,
  '{"keywords": ["budget", "finance", "cost", "price", "calculate", "revenue"]}'::jsonb,
  id FROM agents WHERE name = 'finance';

-- Content agent
INSERT INTO routing_rules (name, description, priority, conditions, target_agent_id)
SELECT 'content_keywords', 'Route writing tasks to content agent', 8,
  '{"keywords": ["write", "draft", "blog", "article", "edit", "proofread"]}'::jsonb,
  id FROM agents WHERE name = 'content';

-- Strategy agent
INSERT INTO routing_rules (name, description, priority, conditions, target_agent_id)
SELECT 'strategy_keywords', 'Route planning tasks to strategy agent', 8,
  '{"keywords": ["plan", "strategy", "roadmap", "decide", "prioritize"]}'::jsonb,
  id FROM agents WHERE name = 'strategy';

-- General agent catches everything else (lowest priority)
INSERT INTO routing_rules (name, description, priority, conditions, target_agent_id)
SELECT 'general_fallback', 'Default agent for general queries', 0,
  '{"fallback": true}'::jsonb,
  id FROM agents WHERE name = 'general';
