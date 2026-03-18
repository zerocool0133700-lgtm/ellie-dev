-- ELLIE-884: Project collaborators — multi-agent project ownership

CREATE TABLE IF NOT EXISTS project_collaborators (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES todo_projects(id) ON DELETE CASCADE,
  agent_type TEXT NOT NULL,
  role TEXT DEFAULT 'contributor' CHECK (role IN ('lead', 'contributor', 'reviewer')),
  added_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (project_id, agent_type)
);

CREATE INDEX IF NOT EXISTS idx_project_collaborators_project
  ON project_collaborators(project_id);
CREATE INDEX IF NOT EXISTS idx_project_collaborators_agent
  ON project_collaborators(agent_type);
