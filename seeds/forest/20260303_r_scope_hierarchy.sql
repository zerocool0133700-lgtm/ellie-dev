-- ELLIE-457: River Integration (R Scope) — Oak Bridge, QMD Wiring, Catalog Sync
-- Registers the R (River) scope hierarchy in knowledge_scopes.
-- R is the Oak / River interface — bridging flowing document knowledge (Obsidian/QMD)
-- with structured Forest memory.
-- All inserts are idempotent (ON CONFLICT DO NOTHING on path).

INSERT INTO knowledge_scopes (id, path, name, level, description, created_at)
VALUES

  -- ── Root ──────────────────────────────────────────────────────────────────
  (gen_random_uuid(), 'R',     'River — The Oak Bridge',        'world',  'River interface scope root. Bridges QMD document knowledge into the Forest.',  now()),

  -- ── R/R  River Root (primary knowledge base) ─────────────────────────────
  (gen_random_uuid(), 'R/R',   'River Root',                    'branch', 'Obsidian/QMD documents — primary knowledge base. Read-only from Forest.',     now()),

  -- ── R/A  River Alternate (future use) ────────────────────────────────────
  (gen_random_uuid(), 'R/A',   'River Alternate',               'branch', 'External docs, API references — flexible, future use.',                       now()),

  -- ── R/1  Oak Catalog ─────────────────────────────────────────────────────
  (gen_random_uuid(), 'R/1',   'Oak Catalog',                   'branch', 'Document manifest — auto-synced from QMD. Title, tags, modified, wordcount.', now())

ON CONFLICT (path) DO NOTHING;

-- Set parent_id references (requires scopes to exist first)
UPDATE knowledge_scopes c
SET    parent_id = p.id
FROM   knowledge_scopes p
WHERE  c.path LIKE 'R/%'
  AND  p.path = 'R'
  AND  c.parent_id IS NULL;

-- Root R scope has no parent (intentionally)
