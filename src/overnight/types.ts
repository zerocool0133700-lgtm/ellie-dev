/**
 * Off-Hours Autonomous Work — Shared Types
 */

export interface OvernightSession {
  id: string;
  started_at: string;
  ends_at: string;
  stopped_at: string | null;
  status: "running" | "completed" | "stopped";
  concurrency_limit: number;
  tasks_total: number;
  tasks_completed: number;
  tasks_failed: number;
  stop_reason: "time_limit" | "user_activity" | "manual" | "all_done" | null;
}

export interface OvernightTaskResult {
  id: string;
  session_id: string;
  gtd_task_id: string;
  assigned_agent: string;
  task_title: string;
  task_content: string | null;
  status: "queued" | "running" | "completed" | "failed" | "merged" | "rejected";
  branch_name: string | null;
  pr_url: string | null;
  pr_number: number | null;
  summary: string | null;
  error: string | null;
  container_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
}

export interface ContainerState {
  taskResultId: string;
  containerId: string;
  containerName: string;
  volumeName: string;
  startedAt: number;
  gtdTaskId: string;
}

export interface SchedulerConfig {
  endsAt: Date;
  concurrencyLimit: number;
  sessionId: string;
}

export type StopReason = "time_limit" | "user_activity" | "manual" | "all_done";
