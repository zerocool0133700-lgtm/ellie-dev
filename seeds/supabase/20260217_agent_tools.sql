-- Populate tools_enabled for all agents
-- General and dev get full access; specialized agents get scoped tools

UPDATE agents SET tools_enabled = ARRAY[
  'Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  'mcp__google-workspace__*', 'mcp__github__*', 'mcp__memory__*',
  'mcp__sequential-thinking__*', 'mcp__plane__*', 'mcp__claude_ai_Miro__*'
] WHERE name IN ('general', 'dev');

UPDATE agents SET tools_enabled = ARRAY[
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  'mcp__google-workspace__*', 'mcp__plane__*', 'mcp__memory__*'
] WHERE name = 'research';

UPDATE agents SET tools_enabled = ARRAY[
  'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  'mcp__google-workspace__*', 'mcp__memory__*'
] WHERE name = 'content';

UPDATE agents SET tools_enabled = ARRAY[
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  'mcp__google-workspace__*', 'mcp__memory__*'
] WHERE name = 'finance';

UPDATE agents SET tools_enabled = ARRAY[
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  'mcp__google-workspace__*', 'mcp__plane__*', 'mcp__memory__*'
] WHERE name = 'strategy';

UPDATE agents SET tools_enabled = ARRAY[
  'Read', 'Glob', 'Grep',
  'mcp__google-workspace__*', 'mcp__memory__*'
] WHERE name = 'critic';
