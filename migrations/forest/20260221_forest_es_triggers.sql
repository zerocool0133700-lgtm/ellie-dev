-- ============================================================
-- ELLIE-110: Forest → Elasticsearch real-time sync triggers
-- ============================================================
--
-- Fires pg_notify on the 'forest_index_queue' channel whenever
-- forest data changes. A TypeScript listener picks these up and
-- indexes to Elasticsearch.
--
-- Payload: JSON { "type": "<entity_type>", "id": "<row_id>" }
-- ============================================================

-- Generic notification function
CREATE OR REPLACE FUNCTION notify_forest_change()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('forest_index_queue', json_build_object(
    'type', TG_ARGV[0],
    'id', NEW.id,
    'op', TG_OP
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- forest_events: notify on INSERT
-- (partitioned table — trigger must be on parent)
CREATE TRIGGER trg_es_forest_event_insert
  AFTER INSERT ON forest_events
  FOR EACH ROW
  EXECUTE FUNCTION notify_forest_change('event');

-- commits: notify on INSERT
CREATE TRIGGER trg_es_forest_commit_insert
  AFTER INSERT ON commits
  FOR EACH ROW
  EXECUTE FUNCTION notify_forest_change('commit');

-- creatures: notify on INSERT and state/completed_at UPDATE
CREATE TRIGGER trg_es_forest_creature_insert
  AFTER INSERT ON creatures
  FOR EACH ROW
  EXECUTE FUNCTION notify_forest_change('creature');

CREATE TRIGGER trg_es_forest_creature_update
  AFTER UPDATE OF state, completed_at ON creatures
  FOR EACH ROW
  EXECUTE FUNCTION notify_forest_change('creature');

-- trees: notify on INSERT and state UPDATE
CREATE TRIGGER trg_es_forest_tree_insert
  AFTER INSERT ON trees
  FOR EACH ROW
  EXECUTE FUNCTION notify_forest_change('tree');

CREATE TRIGGER trg_es_forest_tree_update
  AFTER UPDATE OF state ON trees
  FOR EACH ROW
  EXECUTE FUNCTION notify_forest_change('tree');
