-- Agent Tool Usage Audit Log
-- ELLIE-970: Track which agents use which tools for compliance and debugging

CREATE TABLE IF NOT EXISTS agent_tool_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_category TEXT,  -- e.g., "google_workspace", "bash", "forest_bridge"
  operation TEXT,       -- e.g., "search_gmail_messages", "grep", "forest_read"
  session_id TEXT,      -- Link to agent_sessions if available
  user_id TEXT,
  channel TEXT,
  success BOOLEAN DEFAULT true,
  error_message TEXT,
  parameters JSONB,     -- Tool call parameters (sanitized, no secrets)
  result_summary TEXT,  -- Brief summary of result (not full result)
  duration_ms INTEGER,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB        -- Additional context (work_item_id, etc.)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_agent_tool_usage_agent_name ON agent_tool_usage (agent_name);
CREATE INDEX IF NOT EXISTS idx_agent_tool_usage_tool_name ON agent_tool_usage (tool_name);
CREATE INDEX IF NOT EXISTS idx_agent_tool_usage_timestamp ON agent_tool_usage (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_agent_tool_usage_session ON agent_tool_usage (session_id);
CREATE INDEX IF NOT EXISTS idx_agent_tool_usage_agent_tool ON agent_tool_usage (agent_name, tool_name);

-- Retention policy: auto-delete entries older than 90 days
-- (Can be extended to 1 year for compliance requirements)
CREATE OR REPLACE FUNCTION delete_old_tool_usage_logs() RETURNS void AS $$
BEGIN
  DELETE FROM agent_tool_usage WHERE timestamp < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE agent_tool_usage IS 'Audit log of agent tool/MCP invocations for compliance and behavioral verification';
COMMENT ON COLUMN agent_tool_usage.parameters IS 'Tool parameters with secrets redacted';
COMMENT ON COLUMN agent_tool_usage.result_summary IS 'Brief result summary, not full tool output';
