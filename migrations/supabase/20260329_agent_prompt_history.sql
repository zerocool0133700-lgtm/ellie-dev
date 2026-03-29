-- Agent Prompt History — store recent prompts per agent for debugging (ELLIE task)
-- Supabase migration — apply via: bun run migrate --db supabase

CREATE TABLE IF NOT EXISTS agent_prompt_history (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name          TEXT        NOT NULL,
  channel             TEXT        NOT NULL,
  work_item_id        TEXT,
  prompt_text         TEXT        NOT NULL,
  token_count         INTEGER     DEFAULT 0,
  cost_estimate_usd   NUMERIC(10,4) DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_prompt_history_agent_created
  ON agent_prompt_history (agent_name, created_at DESC);

-- ── Cleanup trigger ────────────────────────────────────────────────────────────
-- On each INSERT: delete entries older than 24 hours, then enforce max 20 per agent.

CREATE OR REPLACE FUNCTION cleanup_old_prompts()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Remove entries older than 24 hours for this agent
  DELETE FROM agent_prompt_history
  WHERE agent_name = NEW.agent_name
    AND created_at < now() - INTERVAL '24 hours';

  -- Enforce max 20 per agent: delete oldest beyond rank 20
  DELETE FROM agent_prompt_history
  WHERE id IN (
    SELECT id
    FROM (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY agent_name
               ORDER BY created_at DESC
             ) AS rn
      FROM agent_prompt_history
      WHERE agent_name = NEW.agent_name
    ) ranked
    WHERE rn > 20
  );

  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_cleanup_old_prompts
  AFTER INSERT ON agent_prompt_history
  FOR EACH ROW EXECUTE FUNCTION cleanup_old_prompts();
