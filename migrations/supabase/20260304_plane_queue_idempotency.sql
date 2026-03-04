-- ELLIE-477: Prevent duplicate comment queue entries on retry.
-- When enqueuePlaneComment is called for the same session after a transient
-- failure, the ON CONFLICT ... DO NOTHING in the INSERT will silently skip
-- the duplicate rather than creating a second comment queue item.

CREATE UNIQUE INDEX IF NOT EXISTS plane_sync_queue_session_dedup
  ON plane_sync_queue (work_item_id, action, session_id)
  WHERE session_id IS NOT NULL;
