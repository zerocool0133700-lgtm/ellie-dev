# Off-Hours Autonomous Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Ellie run GTD tasks overnight in isolated Docker containers, with results (PRs + summaries) ready for morning review on the dashboard.

**Architecture:** Three components — off-hours scheduler (polls GTD, manages sessions), Docker executor (launches/monitors containers via Docker API), morning review dashboard (displays results with approve/reject). Builds on existing `docker-sandbox.ts` patterns and Pope's agent-job container lifecycle.

**Tech Stack:** TypeScript/Bun (relay), Docker Engine API (Unix socket), Pope's coding-agent image, Supabase (session/results tables), Nuxt 4.3 (dashboard)

**Spec:** `docs/superpowers/specs/2026-03-29-off-hours-autonomous-work-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `migrations/supabase/20260329_overnight_tables.sql` | Schema for overnight_sessions + overnight_task_results |
| `src/overnight/docker-executor.ts` | Container lifecycle: create, start, monitor, cleanup, log capture |
| `src/overnight/scheduler.ts` | Background loop: poll GTD, manage concurrency, enforce stop conditions |
| `src/overnight/prompt-builder.ts` | Build task prompt from GTD content + Plane ticket + creature skills |
| `src/overnight/types.ts` | Shared types for sessions, task results, container state |
| `tests/overnight-scheduler.test.ts` | Scheduler logic tests |
| `tests/overnight-docker-executor.test.ts` | Docker executor tests |
| `ellie-home/server/api/overnight/sessions.get.ts` | List sessions API |
| `ellie-home/server/api/overnight/sessions/[id].get.ts` | Session detail API |
| `ellie-home/server/api/overnight/tasks/[id]/approve.post.ts` | Merge PR API |
| `ellie-home/server/api/overnight/tasks/[id]/reject.post.ts` | Close PR API |
| `ellie-home/app/pages/overnight.vue` | Morning review page |

### Modified Files

| File | Change |
|------|--------|
| `src/coordinator-tools.ts` | Add `start_overnight` tool definition |
| `src/coordinator.ts` | Handle `start_overnight` tool call |
| `src/relay.ts` | Import and initialize overnight scheduler module |
| `src/telegram-handlers.ts` | Set user activity flag for scheduler stop detection |
| `src/ellie-chat-handler.ts` | Set user activity flag for scheduler stop detection |

---

## Task 1: Overnight Tables Schema

**Files:**
- Create: `migrations/supabase/20260329_overnight_tables.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Off-hours sessions
CREATE TABLE IF NOT EXISTS overnight_sessions (
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

-- Per-task results
CREATE TABLE IF NOT EXISTS overnight_task_results (
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
CREATE INDEX idx_overnight_sessions_status ON overnight_sessions(status);
```

- [ ] **Step 2: Apply via Supabase Management API**

```bash
cd /home/ellie/ellie-dev
SQL=$(cat migrations/supabase/20260329_overnight_tables.sql)
curl -s -X POST "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/database/query" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg q "$SQL" '{query: $q}')"
```

Expected: `[]` (empty array = success)

- [ ] **Step 3: Commit**

```bash
git add migrations/supabase/20260329_overnight_tables.sql
git commit -m "[ELLIE-1136] Add overnight_sessions and overnight_task_results tables"
```

---

## Task 2: Shared Types

**Files:**
- Create: `src/overnight/types.ts`

- [ ] **Step 1: Create types file**

```typescript
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
```

- [ ] **Step 2: Commit**

```bash
git add src/overnight/types.ts
git commit -m "[ELLIE-1136] Add overnight shared types"
```

---

## Task 3: Docker Executor

**Files:**
- Create: `src/overnight/docker-executor.ts`
- Create: `tests/overnight-docker-executor.test.ts`

This adapts the existing `src/docker-sandbox.ts` patterns (Docker API via Unix socket, resource limits, network isolation) for the overnight agent-job use case.

- [ ] **Step 1: Write the test**

Create `tests/overnight-docker-executor.test.ts`:

```typescript
import { describe, it, expect, mock, beforeEach } from "bun:test";

// Mock the Docker API calls since we can't spawn real containers in tests
const mockDockerApi = mock(() => Promise.resolve({ status: 200, data: {} }));

describe("overnight docker-executor", () => {
  it("buildContainerEnv returns only whitelisted vars", async () => {
    const { buildContainerEnv } = await import("../src/overnight/docker-executor");
    const env = buildContainerEnv({
      ghToken: "ghp_test123",
      claudeOauthToken: "oauth_test456",
      repoUrl: "https://github.com/test/repo.git",
      branch: "overnight/abc123",
      prompt: "Write tests for the auth module",
      systemPrompt: "You are a dev agent with these skills...",
      agentJobId: "abc123",
    });

    // Only whitelisted vars present
    expect(env).toContain("GH_TOKEN=ghp_test123");
    expect(env).toContain("CLAUDE_CODE_OAUTH_TOKEN=oauth_test456");
    expect(env).toContain("RUNTIME=agent-job");
    expect(env).toContain("AGENT=claude-code");
    expect(env).toContain("FEATURE_BRANCH=overnight/abc123");

    // No dangerous vars
    const keys = env.map((e: string) => e.split("=")[0]);
    expect(keys).not.toContain("ANTHROPIC_API_KEY");
    expect(keys).not.toContain("SUPABASE_URL");
    expect(keys).not.toContain("DATABASE_URL");
    expect(keys).not.toContain("BRIDGE_KEY");
  });

  it("buildHostConfig includes resource limits", async () => {
    const { buildHostConfig } = await import("../src/overnight/docker-executor");
    const config = buildHostConfig("overnight-abc123");

    expect(config.Memory).toBe(536870912); // 512MB
    expect(config.NanoCpus).toBe(1000000000); // 1 CPU
    expect(config.AutoRemove).toBe(true);
    expect(config.Binds).toContain("overnight-abc123:/home/coding-agent");
  });

  it("buildHostConfig respects custom limits from env", async () => {
    process.env.OVERNIGHT_MEMORY_LIMIT = "1073741824"; // 1GB
    process.env.OVERNIGHT_CPU_LIMIT = "2000000000"; // 2 CPUs
    const { buildHostConfig } = await import("../src/overnight/docker-executor");
    const config = buildHostConfig("overnight-test");
    expect(config.Memory).toBe(1073741824);
    expect(config.NanoCpus).toBe(2000000000);
    delete process.env.OVERNIGHT_MEMORY_LIMIT;
    delete process.env.OVERNIGHT_CPU_LIMIT;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/overnight-docker-executor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement docker-executor.ts**

Create `src/overnight/docker-executor.ts`:

```typescript
/**
 * Off-Hours Docker Executor — ELLIE-1136
 *
 * Manages container lifecycle for overnight autonomous work.
 * Communicates with Docker Engine via Unix socket API.
 * Adapted from src/docker-sandbox.ts patterns + Pope's agent-job runtime.
 */

import { log } from "../logger.ts";
import type { ContainerState } from "./types.ts";

const logger = log.child("overnight-executor");

const DOCKER_SOCKET = "/var/run/docker.sock";
const CODING_AGENT_IMAGE = process.env.OVERNIGHT_DOCKER_IMAGE || "stephengpope/thepopebot:coding-agent-claude-code-latest";
const DEFAULT_MEMORY = 536870912;   // 512 MB
const DEFAULT_NANO_CPUS = 1000000000; // 1 CPU

// ── Docker API via Unix Socket ───────────────────────────────────────────────

async function dockerApi(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: any }> {
  const url = `http://localhost${path}`;
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    // @ts-expect-error — Bun supports unix socket fetch
    unix: DOCKER_SOCKET,
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface ContainerEnvOpts {
  ghToken: string;
  claudeOauthToken: string;
  repoUrl: string;
  branch: string;
  prompt: string;
  systemPrompt: string;
  agentJobId: string;
}

/**
 * Build the environment variable array for a container.
 * Whitelist-only — no API keys, no DB credentials, no bridge keys.
 */
export function buildContainerEnv(opts: ContainerEnvOpts): string[] {
  return [
    `RUNTIME=agent-job`,
    `AGENT=claude-code`,
    `REPO_URL=${opts.repoUrl}`,
    `FEATURE_BRANCH=${opts.branch}`,
    `AGENT_JOB_ID=${opts.agentJobId}`,
    `GH_TOKEN=${opts.ghToken}`,
    `CLAUDE_CODE_OAUTH_TOKEN=${opts.claudeOauthToken}`,
    `PROMPT=${opts.prompt}`,
    `SYSTEM_PROMPT=${opts.systemPrompt}`,
  ];
}

/**
 * Build the HostConfig for a container with resource limits.
 */
export function buildHostConfig(volumeName: string): Record<string, unknown> {
  return {
    Memory: Number(process.env.OVERNIGHT_MEMORY_LIMIT) || DEFAULT_MEMORY,
    NanoCpus: Number(process.env.OVERNIGHT_CPU_LIMIT) || DEFAULT_NANO_CPUS,
    AutoRemove: true,
    SecurityOpt: ["no-new-privileges"],
    Binds: [`${volumeName}:/home/coding-agent`],
  };
}

/**
 * Create a named Docker volume for the container workspace.
 */
export async function createVolume(name: string): Promise<void> {
  const { status, data } = await dockerApi("POST", "/volumes/create", { Name: name });
  if (status !== 201 && status !== 200) {
    throw new Error(`Failed to create volume ${name}: ${JSON.stringify(data)}`);
  }
  logger.info("Volume created", { name });
}

/**
 * Remove a named Docker volume.
 */
export async function removeVolume(name: string): Promise<void> {
  const { status } = await dockerApi("DELETE", `/volumes/${name}`);
  if (status === 204 || status === 404) {
    logger.info("Volume removed", { name });
  } else {
    logger.warn("Failed to remove volume", { name, status });
  }
}

/**
 * Launch a container for an overnight task.
 * Returns the container ID.
 */
export async function launchContainer(
  containerName: string,
  volumeName: string,
  env: string[],
): Promise<string> {
  const hostConfig = buildHostConfig(volumeName);

  // Create container
  const { status, data } = await dockerApi("POST", `/containers/create?name=${encodeURIComponent(containerName)}`, {
    Image: CODING_AGENT_IMAGE,
    Env: env,
    HostConfig: hostConfig,
  });

  if (status !== 201) {
    throw new Error(`Failed to create container: ${JSON.stringify(data)}`);
  }

  const containerId = data.Id;

  // Start container
  const startRes = await dockerApi("POST", `/containers/${containerId}/start`);
  if (startRes.status !== 204 && startRes.status !== 304) {
    throw new Error(`Failed to start container: ${JSON.stringify(startRes.data)}`);
  }

  logger.info("Container launched", { containerName, containerId: containerId.slice(0, 12) });
  return containerId;
}

/**
 * Wait for a container to exit. Returns the exit code.
 */
export async function waitForContainer(containerId: string): Promise<number> {
  const { data } = await dockerApi("POST", `/containers/${containerId}/wait`);
  return data.StatusCode ?? -1;
}

/**
 * Get container logs (stdout + stderr combined).
 */
export async function getContainerLogs(containerId: string): Promise<string> {
  const { data } = await dockerApi("GET", `/containers/${containerId}/logs?stdout=true&stderr=true&tail=200`);
  if (typeof data === "string") return data;
  return JSON.stringify(data);
}

/**
 * Check if a container is still running.
 */
export async function isContainerRunning(containerId: string): Promise<boolean> {
  try {
    const { data } = await dockerApi("GET", `/containers/${containerId}/json`);
    return data?.State?.Running === true;
  } catch {
    return false;
  }
}

/**
 * Full lifecycle: create volume, launch container, wait, capture logs, cleanup.
 * Returns exit code and logs.
 */
export async function runOvernightTask(
  taskId: string,
  env: string[],
): Promise<{ exitCode: number; logs: string }> {
  const shortId = taskId.replace(/-/g, "").slice(0, 8);
  const volumeName = `overnight-${shortId}`;
  const containerName = `ellie-overnight-${shortId}`;

  try {
    await createVolume(volumeName);
    const containerId = await launchContainer(containerName, volumeName, env);

    const exitCode = await waitForContainer(containerId);
    let logs = "";
    try {
      logs = await getContainerLogs(containerId);
    } catch {
      logger.warn("Could not capture container logs", { containerName });
    }

    return { exitCode, logs };
  } finally {
    // Cleanup volume (container auto-removes via AutoRemove: true)
    await removeVolume(volumeName).catch(() => {});
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd /home/ellie/ellie-dev && bun test tests/overnight-docker-executor.test.ts`
Expected: All tests PASS (env whitelist, resource limits, custom limits).

- [ ] **Step 5: Commit**

```bash
git add src/overnight/docker-executor.ts tests/overnight-docker-executor.test.ts
git commit -m "[ELLIE-1136] Add overnight Docker executor"
```

---

## Task 4: Overnight Prompt Builder

**Files:**
- Create: `src/overnight/prompt-builder.ts`

- [ ] **Step 1: Implement prompt builder**

```typescript
/**
 * Off-Hours Prompt Builder — ELLIE-1136
 *
 * Builds task prompts from GTD content + Plane ticket + creature skills.
 */

import { log } from "../logger.ts";
import { getSkillsForCreature } from "../../ellie-forest/src/creature-skills.ts";
import sql from "../../ellie-forest/src/db.ts";

const logger = log.child("overnight-prompt");

interface PromptOpts {
  taskTitle: string;
  taskContent: string;
  assignedAgent: string;
  workItemId?: string;
}

/**
 * Look up Plane ticket description if a work item ID is referenced.
 */
async function getPlaneTicketContext(workItemId: string): Promise<string | null> {
  try {
    const apiKey = process.env.PLANE_API_KEY;
    if (!apiKey) return null;
    const match = workItemId.match(/^ELLIE-(\d+)$/);
    if (!match) return null;

    const res = await fetch(
      `http://localhost:8082/api/v1/workspaces/evelife/projects/7194ace4-b80e-4c83-8042-c925598accf2/issues/?search=${workItemId}`,
      { headers: { "x-api-key": apiKey } },
    );
    const data = await res.json() as { results?: Array<{ sequence_id: number; name: string; description_html: string }> };
    const issue = data.results?.find(i => i.sequence_id === Number(match[1]));
    if (!issue) return null;
    return `## Ticket: ${workItemId} — ${issue.name}\n\n${issue.description_html?.replace(/<[^>]+>/g, "") || "No description."}`;
  } catch (err) {
    logger.warn("Failed to fetch Plane ticket", { workItemId, error: (err as Error).message });
    return null;
  }
}

/**
 * Look up creature skills for the assigned agent.
 */
async function getAgentSkillContext(agentName: string): Promise<string> {
  try {
    const [entity] = await sql`SELECT id FROM entities WHERE name = ${agentName} AND type = 'agent' AND active = true`;
    if (!entity) return "";
    const skills = await getSkillsForCreature(entity.id);
    if (skills.length === 0) return "";
    return `## Your Skills\nYou have access to these skills: ${skills.join(", ")}`;
  } catch {
    return "";
  }
}

/**
 * Build the full prompt for an overnight task.
 */
export async function buildOvernightPrompt(opts: PromptOpts): Promise<{ prompt: string; systemPrompt: string }> {
  const parts: string[] = [];

  // Task instructions
  parts.push(`# Task: ${opts.taskTitle}`);
  parts.push(opts.taskContent);

  // Plane ticket context if referenced
  if (opts.workItemId) {
    const ticketCtx = await getPlaneTicketContext(opts.workItemId);
    if (ticketCtx) parts.push(ticketCtx);
  }

  const prompt = parts.join("\n\n");

  // System prompt with agent skills
  const skillCtx = await getAgentSkillContext(opts.assignedAgent);
  const systemPrompt = [
    `You are the ${opts.assignedAgent} agent working on an overnight autonomous task.`,
    `Work carefully. Commit your changes. Create a PR with a clear summary of what you did.`,
    `If you get stuck, document what went wrong and exit — don't loop.`,
    skillCtx,
  ].filter(Boolean).join("\n\n");

  return { prompt, systemPrompt };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/overnight/prompt-builder.ts
git commit -m "[ELLIE-1136] Add overnight prompt builder"
```

---

## Task 5: Off-Hours Scheduler

**Files:**
- Create: `src/overnight/scheduler.ts`
- Create: `tests/overnight-scheduler.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/overnight-scheduler.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";

describe("overnight scheduler", () => {
  it("parseEndTime returns 6 AM CST next day by default", async () => {
    const { parseEndTime } = await import("../src/overnight/scheduler");
    const now = new Date("2026-03-29T22:00:00-06:00"); // 10 PM CST
    const end = parseEndTime(undefined, now);
    expect(end.getHours()).toBe(6); // 6 AM next day (in local time)
    expect(end.getDate()).toBe(30); // next day
  });

  it("parseEndTime respects custom hour", async () => {
    const { parseEndTime } = await import("../src/overnight/scheduler");
    const now = new Date("2026-03-29T22:00:00-06:00");
    const end = parseEndTime("4am", now);
    expect(end.getHours()).toBe(4);
  });

  it("shouldStop returns true when past end time", async () => {
    const { shouldStop } = await import("../src/overnight/scheduler");
    const pastEnd = new Date(Date.now() - 60000);
    expect(shouldStop(pastEnd, false)).toBe("time_limit");
  });

  it("shouldStop returns user_activity when flag is set", async () => {
    const { shouldStop } = await import("../src/overnight/scheduler");
    const futureEnd = new Date(Date.now() + 3600000);
    expect(shouldStop(futureEnd, true)).toBe("user_activity");
  });

  it("shouldStop returns null when running normally", async () => {
    const { shouldStop } = await import("../src/overnight/scheduler");
    const futureEnd = new Date(Date.now() + 3600000);
    expect(shouldStop(futureEnd, false)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/overnight-scheduler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement scheduler.ts**

Create `src/overnight/scheduler.ts`:

```typescript
/**
 * Off-Hours Scheduler — ELLIE-1136
 *
 * Background loop that picks up scheduled GTD tasks and dispatches them
 * to Docker containers for autonomous execution.
 */

import { log } from "../logger.ts";
import { getRelayDeps } from "../relay-state.ts";
import { buildContainerEnv, runOvernightTask } from "./docker-executor.ts";
import { buildOvernightPrompt } from "./prompt-builder.ts";
import type { ContainerState, StopReason } from "./types.ts";

const logger = log.child("overnight-scheduler");

const POLL_INTERVAL_MS = 60_000; // 1 minute
const DEFAULT_END_HOUR = 6; // 6 AM CST

let _activeSession: { id: string; endsAt: Date; concurrency: number; timer: ReturnType<typeof setInterval> } | null = null;
let _userActivityFlag = false;
const _runningContainers = new Map<string, ContainerState>();

// ── Public: User Activity Detection ──────────────────────────────────────────

export function flagUserActivity(): void {
  _userActivityFlag = true;
}

export function isOvernightRunning(): boolean {
  return _activeSession !== null;
}

// ── Public: Parse End Time ───────────────────────────────────────────────────

export function parseEndTime(input: string | undefined, now: Date = new Date()): Date {
  const end = new Date(now);

  if (input) {
    const match = input.match(/(\d{1,2})\s*(am|pm)?/i);
    if (match) {
      let hour = parseInt(match[1], 10);
      if (match[2]?.toLowerCase() === "pm" && hour < 12) hour += 12;
      if (match[2]?.toLowerCase() === "am" && hour === 12) hour = 0;
      end.setHours(hour, 0, 0, 0);
    }
  } else {
    end.setHours(DEFAULT_END_HOUR, 0, 0, 0);
  }

  // If end time is before now, push to next day
  if (end <= now) {
    end.setDate(end.getDate() + 1);
  }

  return end;
}

// ── Public: Stop Condition Check ─────────────────────────────────────────────

export function shouldStop(endsAt: Date, userActivity: boolean): StopReason | null {
  if (userActivity) return "user_activity";
  if (new Date() >= endsAt) return "time_limit";
  return null;
}

// ── Public: Start Session ────────────────────────────────────────────────────

export async function startOvernightSession(opts?: {
  endTime?: string;
  concurrency?: number;
}): Promise<string> {
  if (_activeSession) {
    throw new Error("An overnight session is already running");
  }

  const { supabase } = getRelayDeps();
  if (!supabase) throw new Error("Supabase not available");

  const endsAt = parseEndTime(opts?.endTime);
  const concurrency = opts?.concurrency ?? 2;

  // Create session record
  const { data, error } = await supabase
    .from("overnight_sessions")
    .insert({
      ends_at: endsAt.toISOString(),
      concurrency_limit: concurrency,
    })
    .select("id")
    .single();

  if (error || !data) throw new Error(`Failed to create session: ${error?.message}`);

  const sessionId = data.id;
  _userActivityFlag = false;

  logger.info("Overnight session started", { sessionId, endsAt: endsAt.toISOString(), concurrency });

  // Start the polling loop
  const timer = setInterval(() => tick(sessionId, endsAt, concurrency), POLL_INTERVAL_MS);
  _activeSession = { id: sessionId, endsAt, concurrency, timer };

  // Run first tick immediately
  tick(sessionId, endsAt, concurrency);

  return sessionId;
}

// ── Public: Stop Session ─────────────────────────────────────────────────────

export async function stopOvernightSession(reason: StopReason = "manual"): Promise<void> {
  if (!_activeSession) return;

  clearInterval(_activeSession.timer);
  const sessionId = _activeSession.id;
  _activeSession = null;

  const { supabase } = getRelayDeps();
  if (supabase) {
    await supabase
      .from("overnight_sessions")
      .update({ status: "stopped", stopped_at: new Date().toISOString(), stop_reason: reason })
      .eq("id", sessionId);
  }

  logger.info("Overnight session stopped", { sessionId, reason });
}

// ── Private: Scheduler Tick ──────────────────────────────────────────────────

async function tick(sessionId: string, endsAt: Date, concurrency: number): Promise<void> {
  // Check stop conditions
  const stopReason = shouldStop(endsAt, _userActivityFlag);
  if (stopReason) {
    await stopOvernightSession(stopReason);
    return;
  }

  // Check available slots
  const runningCount = _runningContainers.size;
  const availableSlots = concurrency - runningCount;
  if (availableSlots <= 0) return;

  // Query GTD for next tasks
  const { supabase } = getRelayDeps();
  if (!supabase) return;

  const { data: tasks } = await supabase
    .from("todos")
    .select("id, content, assigned_agent, source_ref, priority")
    .eq("status", "open")
    .not("scheduled_at", "is", null)
    .lte("scheduled_at", new Date().toISOString())
    .order("priority", { ascending: true })
    .limit(availableSlots);

  if (!tasks || tasks.length === 0) {
    // Check if all containers are done too
    if (runningCount === 0) {
      await stopOvernightSession("all_done");
    }
    return;
  }

  // Launch containers for each task
  for (const task of tasks) {
    launchTask(sessionId, task).catch((err) => {
      logger.error("Failed to launch overnight task", { taskId: task.id, error: (err as Error).message });
    });
  }
}

// ── Private: Launch Single Task ──────────────────────────────────────────────

async function launchTask(
  sessionId: string,
  task: { id: string; content: string; assigned_agent: string; source_ref?: string; priority?: string },
): Promise<void> {
  const { supabase } = getRelayDeps();
  if (!supabase) return;

  // Extract work item ID from source_ref if present
  const workItemMatch = task.source_ref?.match(/ELLIE-\d+/);
  const workItemId = workItemMatch?.[0];

  // Build prompt
  const { prompt, systemPrompt } = await buildOvernightPrompt({
    taskTitle: task.content.slice(0, 100),
    taskContent: task.content,
    assignedAgent: task.assigned_agent || "dev",
    workItemId,
  });

  // Create task result record
  const { data: result } = await supabase
    .from("overnight_task_results")
    .insert({
      session_id: sessionId,
      gtd_task_id: task.id,
      assigned_agent: task.assigned_agent || "dev",
      task_title: task.content.slice(0, 200),
      task_content: task.content,
      status: "running",
      branch_name: `overnight/${task.id.replace(/-/g, "").slice(0, 8)}`,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (!result) return;

  // Mark GTD task as in-progress
  await supabase.from("todos").update({ status: "open" }).eq("id", task.id);

  // Update session task count
  await supabase.rpc("increment_field", { table_name: "overnight_sessions", field_name: "tasks_total", row_id: sessionId });

  // Build container env
  const ghToken = process.env.OVERNIGHT_GH_TOKEN || process.env.GH_TOKEN || "";
  const claudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || "";
  const repoUrl = process.env.OVERNIGHT_REPO_URL || `https://${ghToken}@github.com/zerocool0133700-lgtm/ellie-dev.git`;

  const env = buildContainerEnv({
    ghToken,
    claudeOauthToken: claudeToken,
    repoUrl,
    branch: `overnight/${task.id.replace(/-/g, "").slice(0, 8)}`,
    prompt,
    systemPrompt,
    agentJobId: task.id,
  });

  // Track running container
  const shortId = task.id.replace(/-/g, "").slice(0, 8);
  _runningContainers.set(task.id, {
    taskResultId: result.id,
    containerId: "",
    containerName: `ellie-overnight-${shortId}`,
    volumeName: `overnight-${shortId}`,
    startedAt: Date.now(),
    gtdTaskId: task.id,
  });

  // Run container (blocking for this task, but launched in parallel via tick)
  try {
    const { exitCode, logs } = await runOvernightTask(task.id, env);

    const duration = Date.now() - (_runningContainers.get(task.id)?.startedAt ?? Date.now());

    if (exitCode === 0) {
      // Extract PR URL from logs (gh pr create outputs it)
      const prUrlMatch = logs.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
      const prUrl = prUrlMatch?.[0] || null;
      const prNumber = prUrl ? parseInt(prUrl.split("/").pop()!) : null;

      await supabase
        .from("overnight_task_results")
        .update({
          status: "completed",
          pr_url: prUrl,
          pr_number: prNumber,
          summary: extractSummary(logs),
          completed_at: new Date().toISOString(),
          duration_ms: duration,
        })
        .eq("id", result.id);

      await supabase.from("todos").update({ status: "done" }).eq("id", task.id);
      await supabase.from("overnight_sessions").update({ tasks_completed: supabase.rpc ? undefined : 0 }).eq("id", sessionId);

      logger.info("Overnight task completed", { taskId: task.id, prUrl, duration });
    } else {
      await supabase
        .from("overnight_task_results")
        .update({
          status: "failed",
          error: logs.slice(-500),
          completed_at: new Date().toISOString(),
          duration_ms: duration,
        })
        .eq("id", result.id);

      logger.warn("Overnight task failed", { taskId: task.id, exitCode, duration });
    }
  } catch (err) {
    await supabase
      .from("overnight_task_results")
      .update({ status: "failed", error: (err as Error).message, completed_at: new Date().toISOString() })
      .eq("id", result.id);

    logger.error("Overnight task error", { taskId: task.id, error: (err as Error).message });
  } finally {
    _runningContainers.delete(task.id);
  }
}

function extractSummary(logs: string): string {
  // Try to find a PR body or summary in the logs
  const lines = logs.split("\n").filter(l => l.trim().length > 0);
  return lines.slice(-20).join("\n").slice(0, 2000);
}
```

- [ ] **Step 4: Run tests**

Run: `cd /home/ellie/ellie-dev && bun test tests/overnight-scheduler.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/overnight/scheduler.ts tests/overnight-scheduler.test.ts
git commit -m "[ELLIE-1136] Add off-hours scheduler"
```

---

## Task 6: Coordinator Integration

**Files:**
- Modify: `src/coordinator-tools.ts`
- Modify: `src/coordinator.ts`
- Modify: `src/relay.ts`
- Modify: `src/telegram-handlers.ts`
- Modify: `src/ellie-chat-handler.ts`

- [ ] **Step 1: Add start_overnight tool definition to coordinator-tools.ts**

Add to the `COORDINATOR_TOOL_DEFINITIONS` array:

```typescript
{
  name: "start_overnight",
  description: "Start the off-hours autonomous work session. Picks up scheduled GTD tasks and runs them in isolated Docker containers. Each task gets its own branch and PR. Use when Dave says 'run the overnight queue', 'start off-hours work', or 'run tonight's tasks'.",
  input_schema: {
    type: "object",
    properties: {
      end_time: {
        type: "string",
        description: "When to stop (e.g. '4am', '6am'). Default: 6 AM CST.",
      },
      concurrency: {
        type: "number",
        description: "Max simultaneous containers. Default: 2.",
      },
    },
    required: [],
  },
}
```

Add `"start_overnight"` to the `CoordinatorToolName` union type.

- [ ] **Step 2: Handle start_overnight in coordinator.ts**

In the tool dispatch switch/if chain in the coordinator loop, add handling for `start_overnight`:

```typescript
if (toolName === "start_overnight") {
  const { startOvernightSession } = await import("./overnight/scheduler.ts");
  try {
    const sessionId = await startOvernightSession({
      endTime: input.end_time,
      concurrency: input.concurrency,
    });
    return { result: `Overnight session started (ID: ${sessionId}). I'll work through the scheduled GTD tasks until ${input.end_time || '6 AM'}. Check /overnight on the dashboard in the morning for results.` };
  } catch (err) {
    return { result: `Failed to start overnight session: ${(err as Error).message}` };
  }
}
```

- [ ] **Step 3: Wire user activity detection in message handlers**

In `src/telegram-handlers.ts`, near the top of the message handler (after rate limit check), add:

```typescript
// ELLIE-1136: Flag user activity so overnight scheduler stops
import { flagUserActivity, isOvernightRunning } from "./overnight/scheduler.ts";
if (isOvernightRunning()) flagUserActivity();
```

Same pattern in `src/ellie-chat-handler.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/coordinator-tools.ts src/coordinator.ts src/telegram-handlers.ts src/ellie-chat-handler.ts
git commit -m "[ELLIE-1136] Wire overnight scheduler into coordinator + activity detection"
```

---

## Task 7: Dashboard API — Overnight Sessions

**Files:**
- Create: `ellie-home/server/api/overnight/sessions.get.ts`
- Create: `ellie-home/server/api/overnight/sessions/[id].get.ts`
- Create: `ellie-home/server/api/overnight/tasks/[id]/approve.post.ts`
- Create: `ellie-home/server/api/overnight/tasks/[id]/reject.post.ts`

- [ ] **Step 1: Sessions list endpoint**

Create `ellie-home/server/api/overnight/sessions.get.ts`:

```typescript
export default defineEventHandler(async () => {
  const { data, error } = await supabase
    .from("overnight_sessions")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(20);

  if (error) throw createError({ statusCode: 500, message: error.message });
  return data;
});
```

- [ ] **Step 2: Session detail endpoint**

Create `ellie-home/server/api/overnight/sessions/[id].get.ts`:

```typescript
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, message: "Session ID required" });

  const [sessionRes, tasksRes] = await Promise.all([
    supabase.from("overnight_sessions").select("*").eq("id", id).single(),
    supabase.from("overnight_task_results").select("*").eq("session_id", id).order("started_at", { ascending: true }),
  ]);

  if (sessionRes.error) throw createError({ statusCode: 404, message: "Session not found" });

  return { session: sessionRes.data, tasks: tasksRes.data ?? [] };
});
```

- [ ] **Step 3: Approve endpoint (merge PR)**

Create `ellie-home/server/api/overnight/tasks/[id]/approve.post.ts`:

```typescript
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, message: "Task ID required" });

  const { data: task } = await supabase
    .from("overnight_task_results")
    .select("pr_number, pr_url")
    .eq("id", id)
    .single();

  if (!task?.pr_number) throw createError({ statusCode: 400, message: "No PR to merge" });

  // Merge via GitHub CLI (relay has gh available)
  const mergeRes = await fetch("http://localhost:3001/api/overnight/merge-pr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pr_number: task.pr_number }),
  });

  if (!mergeRes.ok) {
    const err = await mergeRes.text();
    throw createError({ statusCode: 500, message: `Merge failed: ${err}` });
  }

  await supabase.from("overnight_task_results").update({ status: "merged" }).eq("id", id);
  return { status: "merged" };
});
```

- [ ] **Step 4: Reject endpoint (close PR)**

Create `ellie-home/server/api/overnight/tasks/[id]/reject.post.ts`:

```typescript
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, message: "Task ID required" });
  const body = await readBody(event);

  const { data: task } = await supabase
    .from("overnight_task_results")
    .select("pr_number")
    .eq("id", id)
    .single();

  if (!task?.pr_number) throw createError({ statusCode: 400, message: "No PR to close" });

  await fetch("http://localhost:3001/api/overnight/close-pr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pr_number: task.pr_number, reason: body?.reason }),
  });

  await supabase.from("overnight_task_results").update({ status: "rejected" }).eq("id", id);
  return { status: "rejected" };
});
```

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-home
git add server/api/overnight/
git commit -m "[ELLIE-1136] Add overnight sessions API endpoints"
```

---

## Task 8: Morning Review Dashboard Page

**Files:**
- Create: `ellie-home/app/pages/overnight.vue`

- [ ] **Step 1: Create the page**

Create `ellie-home/app/pages/overnight.vue` with:
- Session list at top (date, times, task counts, status badges)
- Most recent session expanded by default
- Task cards per session: title, agent, status (green/red/blue), branch, PR link, summary text, duration
- Action buttons per task: View PR (external link), Approve (calls POST approve), Reject (calls POST reject with optional reason)
- Session summary footer: totals for completed/failed/merged/pending

Follow existing dashboard patterns:
- `$fetch` for API calls
- Tailwind utility classes only (no `@apply`)
- Match color scheme from other pages (gray-900 backgrounds, gray-800 borders, emerald/red status colors)
- Times displayed in CST (America/Chicago timezone)

The page should show an empty state "No overnight sessions yet" when no data exists.

- [ ] **Step 2: Build and test**

```bash
cd /home/ellie/ellie-home && bun run build && sudo systemctl restart ellie-dashboard
```

Open `dashboard.ellie-labs.dev/overnight`. Verify empty state renders.

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-home
git add app/pages/overnight.vue
git commit -m "[ELLIE-1136] Add overnight morning review page"
```

---

## Summary

| Task | Component | What It Does |
|------|-----------|-------------|
| 1 | Schema | overnight_sessions + overnight_task_results tables |
| 2 | Types | Shared TypeScript interfaces |
| 3 | Docker Executor | Container lifecycle via Docker API with resource limits + secret whitelist |
| 4 | Prompt Builder | Build task prompt from GTD + Plane ticket + creature skills |
| 5 | Scheduler | Background loop: poll GTD, manage concurrency, enforce stop conditions |
| 6 | Coordinator | start_overnight tool + user activity detection for auto-stop |
| 7 | Dashboard API | Sessions list, detail, approve (merge PR), reject (close PR) |
| 8 | Dashboard UI | /overnight morning review page |
