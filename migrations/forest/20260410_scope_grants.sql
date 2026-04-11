-- ELLIE-1535: Scope-keyed grant model for Forest RBAC
-- Implements the scope_grants table from the Alan/James/Brian round table design.
-- Atomic unit of access is knowledge_scopes.id (UUID), not tree/branch/path string.
-- Cascade is explicit boolean on each grant row, not inferred from prefix matching.
-- scope_path is denormalized for query speed; scope_id UUID FK is the durable source of truth.

CREATE TABLE IF NOT EXISTS scope_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id UUID NOT NULL REFERENCES rbac_entities(id) ON DELETE RESTRICT,
  scope_id UUID NOT NULL REFERENCES knowledge_scopes(id) ON DELETE RESTRICT,
  scope_path TEXT NOT NULL,
  permission_id UUID NOT NULL REFERENCES rbac_permissions(id) ON DELETE RESTRICT,
  cascading BOOLEAN NOT NULL DEFAULT false,
  granted_by UUID NOT NULL REFERENCES rbac_entities(id) ON DELETE RESTRICT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  UNIQUE (subject_id, scope_id, permission_id)
);

-- Index for the single-query access check pattern:
-- WHERE subject_id = $subject
--   AND (scope_path = $target
--        OR (cascading = true AND $target LIKE scope_path || '/%'))
CREATE INDEX IF NOT EXISTS idx_scope_grants_access_check
  ON scope_grants (subject_id, scope_path, cascading);

-- Additional indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_scope_grants_scope_id
  ON scope_grants (scope_id);

CREATE INDEX IF NOT EXISTS idx_scope_grants_granted_by
  ON scope_grants (granted_by);

CREATE INDEX IF NOT EXISTS idx_scope_grants_expires
  ON scope_grants (expires_at)
  WHERE expires_at IS NOT NULL;

-- Trigger: sync scope_path from knowledge_scopes on INSERT/UPDATE
-- Ensures denormalized path always matches the source of truth (scope_id)
CREATE OR REPLACE FUNCTION sync_scope_grant_path()
RETURNS TRIGGER AS $$
BEGIN
  SELECT path INTO NEW.scope_path
    FROM knowledge_scopes
    WHERE id = NEW.scope_id;

  IF NEW.scope_path IS NULL THEN
    RAISE EXCEPTION 'scope_id % does not exist in knowledge_scopes', NEW.scope_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_scope_grants_sync_path ON scope_grants;
CREATE TRIGGER trg_scope_grants_sync_path
  BEFORE INSERT OR UPDATE OF scope_id ON scope_grants
  FOR EACH ROW EXECUTE FUNCTION sync_scope_grant_path();

-- Trigger: when a knowledge_scope path changes, refresh all denormalized paths
CREATE OR REPLACE FUNCTION refresh_scope_grant_paths()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.path IS DISTINCT FROM NEW.path THEN
    UPDATE scope_grants
       SET scope_path = NEW.path
     WHERE scope_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_knowledge_scopes_refresh_grants ON knowledge_scopes;
CREATE TRIGGER trg_knowledge_scopes_refresh_grants
  AFTER UPDATE OF path ON knowledge_scopes
  FOR EACH ROW EXECUTE FUNCTION refresh_scope_grant_paths();
