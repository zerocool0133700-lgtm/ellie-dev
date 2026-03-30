-- ELLIE-1141: Atomic increment for overnight session counters
-- Called by the scheduler to safely bump tasks_total, tasks_completed, tasks_failed.
-- Uses a single UPDATE with column-name dispatch to avoid race conditions.

CREATE OR REPLACE FUNCTION increment_session_counter(
  p_session_id UUID,
  p_field TEXT
) RETURNS VOID AS $$
BEGIN
  IF p_field = 'tasks_total' THEN
    UPDATE overnight_sessions
       SET tasks_total = tasks_total + 1
     WHERE id = p_session_id;
  ELSIF p_field = 'tasks_completed' THEN
    UPDATE overnight_sessions
       SET tasks_completed = tasks_completed + 1
     WHERE id = p_session_id;
  ELSIF p_field = 'tasks_failed' THEN
    UPDATE overnight_sessions
       SET tasks_failed = tasks_failed + 1
     WHERE id = p_session_id;
  ELSE
    RAISE EXCEPTION 'Unknown counter field: %', p_field;
  END IF;
END;
$$ LANGUAGE plpgsql;
