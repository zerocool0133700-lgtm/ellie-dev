-- ELLIE-834: Workflow checkpoint tables for durable state persistence
-- Layer 2 of the Process & Communication Protocol Engine.

-- Workflow checkpoint status
DO $$ BEGIN
  CREATE TYPE workflow_checkpoint_status AS ENUM ('pending', 'in_progress', 'completed', 'failed', 'skipped');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Workflow definitions — stored configs for declarative workflows
CREATE TABLE IF NOT EXISTS workflow_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  config JSONB NOT NULL,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Workflow instances — a running execution of a workflow definition
CREATE TABLE IF NOT EXISTS workflow_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id UUID REFERENCES workflow_definitions(id) ON DELETE RESTRICT,
  work_item_id TEXT,
  status workflow_checkpoint_status NOT NULL DEFAULT 'pending',
  current_step INT NOT NULL DEFAULT 0,
  context JSONB DEFAULT '{}',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_instances_status ON workflow_instances(status);
CREATE INDEX IF NOT EXISTS idx_workflow_instances_work_item ON workflow_instances(work_item_id);

-- Workflow checkpoints — per-step state within a workflow instance
CREATE TABLE IF NOT EXISTS workflow_checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  step INT NOT NULL,
  agent TEXT NOT NULL,
  task_id TEXT,
  status workflow_checkpoint_status NOT NULL DEFAULT 'pending',
  input JSONB,
  output JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  metadata JSONB DEFAULT '{}',
  UNIQUE(workflow_id, step)
);

CREATE INDEX IF NOT EXISTS idx_workflow_checkpoints_workflow ON workflow_checkpoints(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_checkpoints_agent ON workflow_checkpoints(agent);
CREATE INDEX IF NOT EXISTS idx_workflow_checkpoints_status ON workflow_checkpoints(status);

-- Workflow messages — agent-to-agent messages within a workflow
CREATE TABLE IF NOT EXISTS workflow_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  receiver TEXT NOT NULL,
  message_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_messages_workflow ON workflow_messages(workflow_id);

-- Updated_at trigger for workflow_definitions
CREATE OR REPLACE FUNCTION update_workflow_definitions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_workflow_definitions_updated_at ON workflow_definitions;
CREATE TRIGGER trg_workflow_definitions_updated_at
  BEFORE UPDATE ON workflow_definitions
  FOR EACH ROW EXECUTE FUNCTION update_workflow_definitions_updated_at();
