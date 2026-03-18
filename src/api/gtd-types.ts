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
  // ELLIE-883: Team assignment
  assigned_to: string | null;
  assigned_agent: string | null;
  delegated_by: string | null;
  delegated_at: string | null;
}

export interface TodoProject {
  id: string;
  name: string;
  status: string;
  outcome: string | null;
  created_at: string;
  updated_at: string;
}

// ELLIE-884: Project collaborators
export interface ProjectCollaborator {
  id: string;
  project_id: string;
  agent_type: string;
  role: "lead" | "contributor" | "reviewer";
  added_at: string;
}

// ELLIE-885: Task dependencies
export interface TodoDependency {
  id: string;
  todo_id: string;
  depends_on: string;
  created_at: string;
}

// ELLIE-903: Workload snapshots
export interface WorkloadSnapshot {
  id: string;
  agent_type: string;
  snapshot_date: string;
  open_count: number;
  waiting_count: number;
  done_count: number;
}

// Agent display name mapping
export const AGENT_DISPLAY_NAMES: Record<string, string> = {
  general: "Ellie",
  dev: "James",
  research: "Kate",
  content: "Amy",
  critic: "Brian",
  strategy: "Alan",
  ops: "Jason",
};
