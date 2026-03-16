-- ELLIE-798: Permission audit logging
-- Tracks permission checks and permission changes for governance.

DO $$ BEGIN
  CREATE TYPE audit_event_type AS ENUM ('check', 'change', 'role_assign', 'role_revoke');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS permission_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type audit_event_type NOT NULL,
  entity_id UUID NOT NULL,
  entity_name TEXT,
  resource TEXT,
  action TEXT,
  scope TEXT,
  result TEXT,
  changed_by UUID,
  old_value TEXT,
  new_value TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_perm_audit_entity ON permission_audit_log(entity_id);
CREATE INDEX IF NOT EXISTS idx_perm_audit_event_type ON permission_audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_perm_audit_created ON permission_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_perm_audit_resource ON permission_audit_log(resource);
CREATE INDEX IF NOT EXISTS idx_perm_audit_result ON permission_audit_log(result) WHERE result = 'deny';
