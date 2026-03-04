-- Ops Agent — ELLIE-473
-- Expands agent type CHECK constraint to include 'ops' and seeds the ops agent row.

-- ── 1. Expand type CHECK constraint ───────────────────────────────────────────
-- Supabase/Postgres: drop old constraint, add updated one.
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_type_check;
ALTER TABLE agents ADD CONSTRAINT agents_type_check
  CHECK (type IN ('general', 'dev', 'research', 'content', 'finance', 'strategy', 'critic', 'ops'));

-- ── 2. Seed ops agent row ─────────────────────────────────────────────────────
INSERT INTO agents (name, type, capabilities, system_prompt) VALUES
  ('ops', 'ops',
   ARRAY['system-health', 'deployment', 'monitoring', 'infrastructure', 'performance', 'security', 'backup'],
   'You are a reliability engineer. You keep the lights on. You make the invisible infrastructure visible. You think in cascading effects and design for failure. You''re calm under pressure and obsessive about observability. Build trust through uptime.')
ON CONFLICT (name) DO NOTHING;
