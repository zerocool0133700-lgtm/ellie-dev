# Off-Hours Autonomous Work — Design Spec

**Date:** 2026-03-29
**Status:** Draft

## Problem

Ellie's agents work well during the day with Dave in the loop. But batch work — writing tests, fixing coverage gaps, working through a backlog of tickets — doesn't need supervision. These tasks should run overnight when the system is free, with results ready for review in the morning.

## Solution

Three components working together:

1. **Off-hours scheduler** — Dave tells Ellie to start the overnight queue. A background loop picks up GTD tasks and dispatches them.
2. **Docker sandbox executor** — each task runs in an isolated Docker container. Agents clone the repo, do the work, commit to a branch, and create a PR with a summary.
3. **Morning review dashboard** — a `/overnight` page showing all overnight results with approve/reject controls for each PR.

## How It Works (End to End)

1. During the day, Dave or Ellie schedules tasks in GTD with `scheduled_at` set to tonight and `assigned_agent` set to the right agent.
2. When Dave is done for the day, he tells Ellie: "run the overnight queue" (or "start off-hours", "run tonight's tasks"). He can specify a stop time; default is 6 AM CST.
3. The scheduler starts a background loop. It queries GTD for actionable tasks with `scheduled_at <= now`, respects a configurable concurrency limit (default 2), and launches Docker containers for each task.
4. Each container: clones the repo, checks out a new branch, runs Claude Code with the task instructions and the assigned agent's creature skills, commits, pushes, creates a PR with a summary comment.
5. When a container finishes (success or failure), the scheduler records the result and picks up the next queued task.
6. The scheduler stops when: stop time is reached, Dave sends a message to Ellie, all tasks are done, or Dave says "stop overnight."
7. In the morning, Dave opens `/overnight` on the dashboard. He sees every task's result: PR link, agent summary, diff preview. He approves (merge) or rejects (close PR) each one.

## Component 1: Off-Hours Scheduler

### Trigger

Dave tells Ellie "run the overnight queue." Ellie recognizes this as an off-hours command (via skill trigger or coordinator tool). Parameters:

- **end_time** — when to stop. Default: 6 AM CST next morning. Dave can override: "run until 4 AM" or "run for 3 hours."
- **concurrency** — max simultaneous containers. Default: 2. Dave can override: "run 3 at a time."

### Session Lifecycle

1. Create an `overnight_sessions` record with start time, end time, concurrency limit, status = `running`
2. Start a background interval (every 60 seconds):
   - Check stop conditions (time limit, user activity, manual stop, all tasks done)
   - If stopped: set session status, stop launching new containers, let running ones finish
   - Count running containers vs concurrency limit
   - If slots available: query GTD for next task (`scheduled_at <= now`, status actionable, ordered by priority), mark it as picked up, launch a Docker container
3. When all containers have exited and no more tasks to process: set session status = `completed`

### Stop Conditions

| Condition | Behavior |
|-----------|----------|
| End time reached (6 AM default) | Stop launching. Running containers finish. |
| Dave sends a message to Ellie | Stop launching. Running containers finish. Session reason: `user_activity` |
| Dave says "stop overnight" | Stop launching. Running containers finish. Session reason: `manual` |
| All GTD tasks processed, no more queued | Session completes naturally. Reason: `all_done` |

### User Activity Detection

The scheduler registers a listener on incoming messages (Telegram and ellie-chat). Any user message sets a flag that the scheduler checks on its next tick. This does not interrupt running containers — it only prevents new ones from launching.

### New File

`src/off-hours-scheduler.ts` — scheduler loop, session management, stop condition checks, GTD task polling.

### Integration Points

- **Coordinator**: recognizes "run the overnight queue" and calls `startOffHoursSession()` with parameters
- **Message handlers**: set an activity flag when Dave sends a message so the scheduler knows to stop
- **Docker executor**: called by the scheduler to launch containers

## Component 2: Docker Sandbox Executor

### Container Lifecycle

When the scheduler picks up a task:

1. **Create named volume**: `overnight-{taskId-short}` (first 8 chars of task UUID)
2. **Build prompt**: combine GTD task content + linked Plane ticket description (if `source_ref` references an ELLIE-XXX ticket). Look up the assigned agent's creature → creature_skills, load the corresponding SKILL.md instructions, and include them in the system prompt passed to Claude Code via `--append-system-prompt`.
3. **Launch container** from the coding agent image with environment:
   - `GH_TOKEN` — for repo clone + push + PR creation
   - `CLAUDE_CODE_OAUTH_TOKEN` — Claude Code uses Max subscription, not API credits
   - `RUNTIME=agent-job` — Pope's autonomous job runtime
   - `AGENT=claude-code` — use Claude Code as the agent
   - `REPO_URL` — the repo to clone (with token embedded)
   - `FEATURE_BRANCH=overnight/{task-id-short}`
   - `PROMPT` — the task instructions
   - `SYSTEM_PROMPT` — creature skills + agent context
4. **Container runs**: clone → branch → Claude Code works → commit → push → create PR with summary
5. **Monitor**: poll container status every 30 seconds via Docker API

### On Container Exit

- **Exit 0 (success)**:
  - Capture PR URL from container logs or GitHub API
  - Extract agent summary from PR body
  - Update `overnight_task_results`: status = `completed`, PR URL, summary, duration
  - Update GTD task: status = `done`
- **Non-zero exit (failure)**:
  - Capture error from container logs
  - Update `overnight_task_results`: status = `failed`, error text, duration
  - GTD task stays actionable (can be retried next night)
- **Either way**: remove named volume, free concurrency slot, notify scheduler

### Docker Communication

All container management via Docker Engine API over Unix socket (`/var/run/docker.sock`), following Pope's pattern. No Docker CLI dependency.

Key operations:
- `POST /containers/create` — create container with env + volume mounts
- `POST /containers/{id}/start` — start container
- `GET /containers/{id}/json` — inspect status
- `GET /containers/{id}/wait` — block until exit
- `GET /containers/{id}/logs` — capture output
- `DELETE /volumes/{name}` — cleanup after exit

### Docker Image

Use Pope's `coding-agent-claude-code` image (or a locally built variant). The image includes: Node.js, GitHub CLI, Claude Code, git, build tools. The entrypoint scripts handle clone, auth, branch, run, commit, push, PR creation.

### New File

`src/docker-executor.ts` — container create/start/monitor/cleanup, volume management, log capture, prompt building.

## Component 3: Morning Review Dashboard

### New Page: `/overnight`

Shows off-hours sessions and their task results.

### Session List

Top of page or sidebar:
- Each session: date, start/end times, task count, success/fail counts
- Most recent session expanded by default
- Click to select older sessions

### Task Results (per session)

Each task card shows:
- Task title + assigned agent name
- Status badge: completed (green) / failed (red) / running (blue, if session still active)
- Branch name
- PR link (clickable, opens GitHub)
- Agent's summary comment (the "what I did" from the PR body)
- Duration
- For failures: error summary

### Actions Per Task

- **View PR** — opens GitHub PR in new tab
- **View Diff** — inline diff preview (fetched via GitHub API)
- **Approve** — merges the PR via GitHub API, updates task result status to `merged`
- **Reject** — closes the PR via GitHub API, optionally adds a reason comment, updates task result status to `rejected`

### Session Summary Footer

Persistent at bottom: total tasks, completed, failed, PRs merged, PRs pending, total duration.

### API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET /api/overnight/sessions` | GET | List sessions (most recent first) |
| `GET /api/overnight/sessions/{id}` | GET | Session detail with task results |
| `POST /api/overnight/tasks/{id}/approve` | POST | Merge PR via GitHub API |
| `POST /api/overnight/tasks/{id}/reject` | POST | Close PR, optional reason |

## Data Model

### New Table: `overnight_sessions` (Supabase)

```sql
CREATE TABLE overnight_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ NOT NULL,
  stopped_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'stopped')),
  concurrency_limit INT NOT NULL DEFAULT 2,
  tasks_total INT NOT NULL DEFAULT 0,
  tasks_completed INT NOT NULL DEFAULT 0,
  tasks_failed INT NOT NULL DEFAULT 0,
  stop_reason TEXT
    CHECK (stop_reason IN ('time_limit', 'user_activity', 'manual', 'all_done'))
);
```

### New Table: `overnight_task_results` (Supabase)

```sql
CREATE TABLE overnight_task_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES overnight_sessions(id),
  gtd_task_id UUID NOT NULL,
  assigned_agent TEXT NOT NULL,
  task_title TEXT NOT NULL,
  task_content TEXT,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'merged', 'rejected')),
  branch_name TEXT,
  pr_url TEXT,
  pr_number INT,
  summary TEXT,
  error TEXT,
  container_id TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  duration_ms INT
);

CREATE INDEX idx_overnight_results_session ON overnight_task_results(session_id);
CREATE INDEX idx_overnight_results_status ON overnight_task_results(status);
```

No changes to existing GTD tables. The scheduler reads GTD tasks and updates their status when picked up and completed.

## New Files Summary

| File | Responsibility |
|------|---------------|
| `src/off-hours-scheduler.ts` | Scheduler loop, session management, GTD polling, stop conditions |
| `src/docker-executor.ts` | Container lifecycle via Docker API, volume management, log capture |
| `migrations/supabase/20260329_overnight_tables.sql` | Schema for sessions + task results |
| `ellie-home/server/api/overnight/sessions.get.ts` | List sessions |
| `ellie-home/server/api/overnight/sessions/[id].get.ts` | Session detail |
| `ellie-home/server/api/overnight/tasks/[id]/approve.post.ts` | Merge PR |
| `ellie-home/server/api/overnight/tasks/[id]/reject.post.ts` | Close PR |
| `ellie-home/app/pages/overnight.vue` | Morning review page |

## Modified Files

| File | Change |
|------|--------|
| `src/relay.ts` | Import and initialize scheduler module |
| `src/coordinator-tools.ts` | Add `start_overnight` tool for coordinator |
| `src/telegram-handlers.ts` | Set user activity flag for scheduler stop detection |
| `src/ellie-chat-handler.ts` | Set user activity flag for scheduler stop detection |

## Build Order

1. Schema (overnight tables)
2. Docker executor (container lifecycle — can be tested independently)
3. Off-hours scheduler (depends on executor)
4. Coordinator integration (start/stop commands)
5. Dashboard API endpoints
6. Morning review page

## What This Does NOT Cover

- Automatic task creation from coverage reports or analysis results (future — agents could queue follow-up tasks in GTD)
- Container resource limits (CPU/memory caps per container — add later if needed)
- Multi-repo support (currently assumes one repo per task)
- Notifications to Telegram when overnight session completes (dashboard only for now)
- Retry logic for failed tasks (task stays in GTD, can be manually rescheduled)
