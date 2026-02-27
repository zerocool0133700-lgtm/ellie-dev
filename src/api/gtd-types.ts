/**
 * Shared types for GTD-related modules.
 *
 * ELLIE-283: Single source of truth for todo/project row shapes.
 * Used by: gtd.ts, weekly-review.ts
 */

export interface TodoRow {
  id: string;
  content: string;
  status: string;
  priority: string | null;
  due_date: string | null;
  tags: string[];
  waiting_on: string | null;
  waiting_since: string | null;  // ELLIE-291
  project_id: string | null;
  source_type: string | null;
  source_ref: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TodoProject {
  id: string;
  name: string;
  status: string;
  outcome: string | null;
  created_at: string;
  updated_at: string;
}
