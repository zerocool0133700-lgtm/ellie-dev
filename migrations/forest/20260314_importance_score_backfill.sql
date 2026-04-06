-- ============================================================
-- Backfill importance_score for shared_memories (ELLIE-634)
-- ============================================================
-- The shared_memories table was created with importance_score DEFAULT 0.5,
-- but temporal decay scoring requires proper importance values by type.
-- This backfill applies to all records with importance_score < 3.0
-- (catches the old default of 0.5 and any other low values).
-- ============================================================

UPDATE shared_memories SET importance_score = CASE type
  WHEN 'decision' THEN 8.0
  WHEN 'finding' THEN 6.0
  WHEN 'preference' THEN 7.0
  WHEN 'fact' THEN 5.0
  WHEN 'hypothesis' THEN 4.0
  WHEN 'contradiction' THEN 3.0
  ELSE 5.0
END
WHERE importance_score < 3.0;
