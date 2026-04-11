-- ELLIE-1417: Add RLS visibility enforcement to memory and conversation_facts tables
--
-- Problem: memory table has RLS enabled but the only policy is "Allow all" (USING true).
-- The visibility column (private/shared/global) is never enforced at the DB level.
-- conversation_facts has no RLS at all.
--
-- This migration:
--   1. Replaces the blanket "allow all" policy on memory with role-aware policies
--   2. Updates get_facts() and get_active_goals() to filter by visibility
--   3. Enables RLS on conversation_facts with service-role-only access

-- ============================================================
-- 1. MEMORY TABLE — Replace blanket policy with visibility-aware policies
-- ============================================================

-- Drop the existing overly-permissive policy
DROP POLICY IF EXISTS "Allow all for service role" ON memory;

-- Service role bypasses RLS automatically in Supabase, but we add an explicit
-- policy for the postgres role (used by RPC functions with SECURITY DEFINER).
CREATE POLICY "service_role_full_access"
  ON memory FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Authenticated users: can see global + shared; private only if they own it.
-- Agent identity is passed via request header: current_setting('request.jwt.claims')::json->>'sub'
-- For service-side calls, agent identity is set via: set_config('app.current_agent', 'agent_name', true)
CREATE POLICY "authenticated_visibility_read"
  ON memory FOR SELECT
  TO authenticated
  USING (
    visibility = 'global'
    OR visibility = 'shared'
    OR (visibility = 'private' AND source_agent = coalesce(
      current_setting('app.current_agent', true),
      (current_setting('request.jwt.claims', true)::json->>'sub')
    ))
  );

-- Authenticated users can insert (agent writes go through service role, but defense-in-depth)
CREATE POLICY "authenticated_insert"
  ON memory FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Authenticated users can update/delete only their own rows
CREATE POLICY "authenticated_modify_own"
  ON memory FOR UPDATE
  TO authenticated
  USING (source_agent = coalesce(
    current_setting('app.current_agent', true),
    (current_setting('request.jwt.claims', true)::json->>'sub')
  ))
  WITH CHECK (source_agent = coalesce(
    current_setting('app.current_agent', true),
    (current_setting('request.jwt.claims', true)::json->>'sub')
  ));

CREATE POLICY "authenticated_delete_own"
  ON memory FOR DELETE
  TO authenticated
  USING (source_agent = coalesce(
    current_setting('app.current_agent', true),
    (current_setting('request.jwt.claims', true)::json->>'sub')
  ));

-- Anonymous access: global memories only, read-only
CREATE POLICY "anon_global_read"
  ON memory FOR SELECT
  TO anon
  USING (visibility = 'global');


-- ============================================================
-- 2. UPDATE RPC FUNCTIONS — Add visibility filtering
-- ============================================================

-- get_facts: accepts optional requesting_agent parameter.
-- Returns global + shared facts always; private facts only for the owning agent.
CREATE OR REPLACE FUNCTION get_facts(requesting_agent TEXT DEFAULT NULL)
RETURNS TABLE (
  id UUID,
  content TEXT,
  source_agent TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.content, m.source_agent
  FROM memory m
  WHERE m.type = 'fact'
    AND (
      m.visibility IN ('global', 'shared')
      OR (m.visibility = 'private' AND requesting_agent IS NOT NULL AND m.source_agent = requesting_agent)
    )
  ORDER BY m.created_at DESC;
END;
$$ LANGUAGE plpgsql;

-- get_active_goals: accepts optional requesting_agent parameter.
-- Returns global + shared goals always; private goals only for the owning agent.
CREATE OR REPLACE FUNCTION get_active_goals(requesting_agent TEXT DEFAULT NULL)
RETURNS TABLE (
  id UUID,
  content TEXT,
  deadline TIMESTAMPTZ,
  priority INTEGER,
  source_agent TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT m.id, m.content, m.deadline, m.priority, m.source_agent
  FROM memory m
  WHERE m.type = 'goal'
    AND (
      m.visibility IN ('global', 'shared')
      OR (m.visibility = 'private' AND requesting_agent IS NOT NULL AND m.source_agent = requesting_agent)
    )
  ORDER BY m.priority DESC, m.created_at DESC;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- 3. CONVERSATION_FACTS — Enable RLS (service-role only)
-- ============================================================

ALTER TABLE conversation_facts ENABLE ROW LEVEL SECURITY;

-- Service role gets full access (relay is the only writer/reader)
CREATE POLICY "service_role_full_access"
  ON conversation_facts FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Block anon and authenticated access entirely — no direct client access
CREATE POLICY "deny_anon"
  ON conversation_facts FOR SELECT
  TO anon
  USING (false);

CREATE POLICY "deny_authenticated"
  ON conversation_facts FOR SELECT
  TO authenticated
  USING (false);
