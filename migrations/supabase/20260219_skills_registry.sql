-- ELLIE-53: Skill registry for agent routing
-- Skills provide fine-grained intent matching within agents.
-- Each skill belongs to one agent (one-to-many via agent_id).
-- Chain-scoped by owner_id (same pattern as groups table).

-- ============================================================
-- SKILLS TABLE
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
-- SEED: 18 Skills across 7 agents
-- ============================================================
DO $$
DECLARE
  v_owner_id UUID;
  v_general UUID;
  v_dev UUID;
  v_research UUID;
  v_content UUID;
  v_finance UUID;
  v_strategy UUID;
  v_critic UUID;
BEGIN
  SELECT id INTO v_owner_id FROM people WHERE relationship_type = 'self' LIMIT 1;
  IF v_owner_id IS NULL THEN
    RAISE NOTICE 'No chain owner found — skipping skill seed';
    RETURN;
  END IF;

  SELECT id INTO v_general FROM agents WHERE name = 'general';
  SELECT id INTO v_dev FROM agents WHERE name = 'dev';
  SELECT id INTO v_research FROM agents WHERE name = 'research';
  SELECT id INTO v_content FROM agents WHERE name = 'content';
  SELECT id INTO v_finance FROM agents WHERE name = 'finance';
  SELECT id INTO v_strategy FROM agents WHERE name = 'strategy';
  SELECT id INTO v_critic FROM agents WHERE name = 'critic';

  INSERT INTO skills (agent_id, owner_id, name, description, triggers, requires_tools, requires_confirm, parameters, priority) VALUES

  -- GENERAL AGENT (7 skills)
  (v_general, v_owner_id, 'memory_store',
   'Save facts, preferences, or information to long-term memory for future reference.',
   ARRAY['remember', 'save this', 'note that', 'don''t forget', 'keep in mind'],
   ARRAY['mcp__memory__*'], false, '{}', 5),

  (v_general, v_owner_id, 'memory_recall',
   'Search and retrieve previously stored facts, preferences, and context from memory.',
   ARRAY['do you remember', 'what did I say about', 'recall', 'what do you know about'],
   ARRAY['mcp__memory__*'], false, '{}', 5),

  (v_general, v_owner_id, 'goal_management',
   'Create, track, update, or complete personal and professional goals.',
   ARRAY['goal', 'objective', 'target', 'milestone', 'track progress', 'set a goal', 'complete goal'],
   ARRAY['mcp__memory__*'], false, '{}', 6),

  (v_general, v_owner_id, 'daily_coordination',
   'Morning briefings, daily planning, schedule overview, and general task coordination.',
   ARRAY['what''s on today', 'morning briefing', 'daily plan', 'what should I focus on', 'priorities today'],
   ARRAY['mcp__google-workspace__get_events', 'mcp__google-workspace__list_tasks'], false, '{}', 4),

  (v_general, v_owner_id, 'email_management',
   'Manage email across Gmail and Outlook/Hotmail — search, read, send, reply, draft.',
   ARRAY['email', 'gmail', 'outlook', 'hotmail', 'inbox', 'send email', 'reply to', 'draft email', 'mail', 'unread', 'microsoft', 'check email'],
   ARRAY['mcp__google-workspace__search_gmail_messages', 'mcp__google-workspace__send_gmail_message'], true, '{}', 8),

  (v_general, v_owner_id, 'calendar_management',
   'View, create, modify, and manage Google Calendar events and scheduling.',
   ARRAY['calendar', 'schedule', 'meeting', 'event', 'book time', 'free slot', 'availability', 'when am I'],
   ARRAY['mcp__google-workspace__get_events', 'mcp__google-workspace__create_event'], true, '{}', 8),

  (v_general, v_owner_id, 'task_management',
   'Create, list, update, and complete Google Tasks for personal task tracking.',
   ARRAY['task', 'todo', 'to-do', 'add task', 'complete task', 'check off', 'task list'],
   ARRAY['mcp__google-workspace__list_tasks', 'mcp__google-workspace__create_task'], false, '{}', 7),

  -- DEV AGENT (3 skills)
  (v_dev, v_owner_id, 'code_changes',
   'Write, edit, refactor, or debug code. Implement features, fix bugs, and make file changes.',
   ARRAY['code', 'implement', 'refactor', 'fix bug', 'debug', 'write function', 'add feature', 'change the code'],
   ARRAY['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'], false, '{}', 8),

  (v_dev, v_owner_id, 'git_operations',
   'Git workflow: commit, push, pull, branch management, PR creation, and deployment.',
   ARRAY['commit', 'push', 'pull', 'branch', 'merge', 'deploy', 'PR', 'pull request', 'git'],
   ARRAY['Bash', 'mcp__github__*'], true, '{}', 7),

  (v_dev, v_owner_id, 'plane_issue_crud',
   'Create, update, list, and manage Plane project management issues and work items.',
   ARRAY['create issue', 'create ticket', 'new task', 'update issue', 'ELLIE-', 'EVE-', 'work item', 'plane', 'backlog'],
   ARRAY['mcp__plane__*'], false, '{"workspace": "evelife"}', 7),

  -- RESEARCH AGENT (3 skills)
  (v_research, v_owner_id, 'web_research',
   'Search the web, gather information, and synthesize findings on any topic.',
   ARRAY['search for', 'look up', 'find out', 'research', 'investigate', 'what is', 'who is'],
   ARRAY['WebSearch', 'WebFetch', 'mcp__brave-search__brave_web_search'], false, '{}', 7),

  (v_research, v_owner_id, 'code_analysis',
   'Analyze codebases, trace logic, understand architecture, and provide technical summaries.',
   ARRAY['analyze code', 'explain this code', 'how does this work', 'trace through', 'code review', 'architecture'],
   ARRAY['Read', 'Glob', 'Grep'], false, '{}', 6),

  (v_research, v_owner_id, 'summarization',
   'Summarize documents, articles, threads, or large bodies of text into concise overviews.',
   ARRAY['summarize', 'TLDR', 'key points', 'summary of', 'break down', 'digest'],
   ARRAY['Read', 'WebFetch'], false, '{}', 5),

  -- CONTENT AGENT (2 skills)
  (v_content, v_owner_id, 'writing',
   'Draft, write, or edit blog posts, articles, documentation, emails, and other content.',
   ARRAY['write', 'draft', 'blog', 'article', 'document', 'compose', 'author'],
   ARRAY['Read', 'Edit', 'Write'], false, '{}', 7),

  (v_content, v_owner_id, 'editing',
   'Proofread, revise, improve tone, and refine existing text or documents.',
   ARRAY['edit', 'proofread', 'revise', 'improve', 'rewrite', 'polish', 'tone'],
   ARRAY['Read', 'Edit', 'Write'], false, '{}', 6),

  -- FINANCE AGENT (1 skill)
  (v_finance, v_owner_id, 'financial_analysis',
   'Budget analysis, cost calculations, financial reporting, and revenue projections.',
   ARRAY['budget', 'cost', 'price', 'revenue', 'profit', 'expense', 'financial', 'ROI', 'calculate'],
   ARRAY['Read', 'WebSearch'], false, '{}', 7),

  -- STRATEGY AGENT (1 skill)
  (v_strategy, v_owner_id, 'strategic_planning',
   'Long-term planning, roadmapping, decision frameworks, and priority alignment.',
   ARRAY['plan', 'strategy', 'roadmap', 'decide', 'prioritize', 'tradeoff', 'pros and cons', 'long-term'],
   ARRAY['Read', 'WebSearch', 'mcp__plane__*'], false, '{}', 7),

  -- CRITIC AGENT (1 skill)
  (v_critic, v_owner_id, 'critical_review',
   'Review plans, code, writing, or ideas. Provide constructive critique and identify weaknesses.',
   ARRAY['review', 'critique', 'feedback', 'evaluate', 'assess', 'audit', 'what do you think', 'check my'],
   ARRAY['Read', 'Glob', 'Grep'], false, '{}', 7)

  ON CONFLICT (owner_id, name) DO NOTHING;
END $$;
