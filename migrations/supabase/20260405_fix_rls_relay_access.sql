-- ELLIE-1428: Fix RLS policies that block the relay (which uses anon key)
-- The relay is a trusted server-side component that needs full access.
-- The 20260404_memory_visibility_rls migration broke conversation_facts
-- and restricted memory reads, cutting off the entire Supabase→Forest pipeline.

-- ============================================================
-- 1. CONVERSATION_FACTS — Allow anon full access (relay uses anon key)
-- ============================================================

DROP POLICY IF EXISTS "deny_anon" ON conversation_facts;
DROP POLICY IF EXISTS "deny_authenticated" ON conversation_facts;

-- Relay (anon key) needs full CRUD on conversation_facts
CREATE POLICY "anon_full_access"
  ON conversation_facts FOR ALL
  TO anon
  USING (true)
  WITH CHECK (true);

CREATE POLICY "authenticated_full_access"
  ON conversation_facts FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- ============================================================
-- 2. MEMORY TABLE — Restore anon read access for the relay
-- ============================================================

DROP POLICY IF EXISTS "anon_global_read" ON memory;

-- Relay needs to read all memories (not just global)
CREATE POLICY "anon_full_read"
  ON memory FOR SELECT
  TO anon
  USING (true);

-- Relay needs to insert/update memories
CREATE POLICY "anon_insert"
  ON memory FOR INSERT
  TO anon
  WITH CHECK (true);

CREATE POLICY "anon_update"
  ON memory FOR UPDATE
  TO anon
  USING (true)
  WITH CHECK (true);

CREATE POLICY "anon_delete"
  ON memory FOR DELETE
  TO anon
  USING (true);
