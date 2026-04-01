-- ELLIE-1154: Atomic operations for orchestration concurrency safety
--
-- Fixes race conditions and adds transaction boundaries:
-- 1. check_parent_completion_atomic() — uses FOR UPDATE to prevent duplicate parent updates
-- 2. cancel_item_cascade() — atomically cancels item + all descendants + checks parent
-- 3. update_item_status_atomic() — atomically updates status + merges metadata + checks parent
-- 4. answer_question_atomic() — atomically answers question + checks parent

-- ── 1. Atomic parent completion check ──────────────────────────
-- Uses SELECT ... FOR UPDATE on the parent row to serialize concurrent checks.
-- Returns the new parent status (or NULL if no change was made).
CREATE OR REPLACE FUNCTION check_parent_completion_atomic(p_parent_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_parent_status TEXT;
  v_all_terminal BOOLEAN;
  v_all_done BOOLEAN;
  v_any_failed BOOLEAN;
  v_new_status TEXT;
BEGIN
  -- Lock the parent row to serialize concurrent child completions
  SELECT status INTO v_parent_status
  FROM todos
  WHERE id = p_parent_id
  FOR UPDATE;

  IF v_parent_status IS NULL THEN
    RETURN NULL; -- parent not found
  END IF;

  -- If parent is already terminal, no-op
  IF v_parent_status IN ('done', 'cancelled', 'failed', 'timed_out') THEN
    RETURN NULL;
  END IF;

  -- Check children states
  SELECT
    bool_and(status IN ('done', 'cancelled', 'failed', 'timed_out')),
    bool_and(status IN ('done', 'cancelled')),
    bool_or(status IN ('failed', 'timed_out'))
  INTO v_all_terminal, v_all_done, v_any_failed
  FROM todos
  WHERE parent_id = p_parent_id;

  -- No children or not all terminal → no change
  IF v_all_terminal IS NULL OR NOT v_all_terminal THEN
    RETURN NULL;
  END IF;

  -- Determine new parent status
  IF v_all_done THEN
    v_new_status := 'done';
  ELSIF v_any_failed THEN
    v_new_status := 'waiting_for';
  ELSE
    v_new_status := 'cancelled';
  END IF;

  -- Update parent atomically
  UPDATE todos
  SET status = v_new_status,
      completed_at = CASE WHEN v_new_status = 'done' THEN now() ELSE completed_at END
  WHERE id = p_parent_id;

  RETURN v_new_status;
END;
$$;

-- ── 2. Atomic cancel cascade ───────────────────────────────────
-- Cancels the item and all non-terminal descendants in a single transaction.
-- Returns the number of items cancelled (including the target).
CREATE OR REPLACE FUNCTION cancel_item_cascade(p_item_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_parent_id UUID;
  v_cancelled_count INTEGER := 0;
  v_rows INTEGER;
BEGIN
  -- Get the parent_id before cancelling
  SELECT parent_id INTO v_parent_id
  FROM todos
  WHERE id = p_item_id;

  -- Cancel the item itself (if not already terminal)
  UPDATE todos
  SET status = 'cancelled'
  WHERE id = p_item_id
    AND status NOT IN ('done', 'cancelled', 'failed', 'timed_out');

  GET DIAGNOSTICS v_cancelled_count = ROW_COUNT;

  -- Cancel all non-terminal descendants using recursive CTE
  WITH RECURSIVE descendants AS (
    SELECT id FROM todos WHERE parent_id = p_item_id
    UNION ALL
    SELECT t.id FROM todos t JOIN descendants d ON t.parent_id = d.id
  )
  UPDATE todos
  SET status = 'cancelled'
  WHERE id IN (SELECT id FROM descendants)
    AND status NOT IN ('done', 'cancelled', 'failed', 'timed_out');

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_cancelled_count := v_cancelled_count + v_rows;

  -- Check parent completion if item has a parent
  IF v_parent_id IS NOT NULL THEN
    PERFORM check_parent_completion_atomic(v_parent_id);
  END IF;

  RETURN v_cancelled_count;
END;
$$;

-- ── 3. Atomic status update ────────────────────────────────────
-- Updates item status, merges metadata, and checks parent completion — all in one transaction.
-- Returns the parent_id (or NULL if no parent).
CREATE OR REPLACE FUNCTION update_item_status_atomic(
  p_item_id UUID,
  p_status TEXT,
  p_metadata JSONB DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_parent_id UUID;
  v_existing_metadata JSONB;
BEGIN
  -- Validate status
  IF p_status NOT IN ('inbox', 'open', 'waiting_for', 'someday', 'done', 'cancelled', 'failed', 'timed_out') THEN
    RAISE EXCEPTION 'Invalid status "%". Must be one of: inbox, open, waiting_for, someday, done, cancelled, failed, timed_out', p_status;
  END IF;

  -- Fetch current item (lock row to prevent concurrent modifications)
  SELECT parent_id, COALESCE(metadata, '{}'::jsonb)
  INTO v_parent_id, v_existing_metadata
  FROM todos
  WHERE id = p_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Item % not found', p_item_id;
  END IF;

  -- Update the item
  UPDATE todos
  SET status = p_status,
      completed_at = CASE WHEN p_status = 'done' THEN now() ELSE completed_at END,
      metadata = CASE
        WHEN p_metadata IS NOT NULL THEN v_existing_metadata || p_metadata
        ELSE metadata
      END
  WHERE id = p_item_id;

  -- Check parent completion if item has a parent and new status is terminal
  IF v_parent_id IS NOT NULL AND p_status IN ('done', 'cancelled', 'failed', 'timed_out') THEN
    PERFORM check_parent_completion_atomic(v_parent_id);
  END IF;

  RETURN v_parent_id;
END;
$$;

-- ── 4. Atomic answer question ──────────────────────────────────
-- Answers a question item: marks done, stores answer in metadata, checks parent.
-- Returns the parent_id.
CREATE OR REPLACE FUNCTION answer_question_atomic(
  p_question_id UUID,
  p_answer_text TEXT
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_parent_id UUID;
  v_existing_metadata JSONB;
BEGIN
  -- Lock and fetch the question
  SELECT parent_id, COALESCE(metadata, '{}'::jsonb)
  INTO v_parent_id, v_existing_metadata
  FROM todos
  WHERE id = p_question_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Question % not found', p_question_id;
  END IF;

  -- Mark done with answer in metadata
  UPDATE todos
  SET status = 'done',
      completed_at = now(),
      metadata = v_existing_metadata || jsonb_build_object('answer', p_answer_text)
  WHERE id = p_question_id;

  -- Check parent completion
  IF v_parent_id IS NOT NULL THEN
    PERFORM check_parent_completion_atomic(v_parent_id);
  END IF;

  RETURN v_parent_id;
END;
$$;
