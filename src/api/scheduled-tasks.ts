/**
 * Scheduled Tasks REST API — ELLIE-976
 *
 * CRUD + toggle + run history for user-configurable cron tasks.
 * Mounted under /api/scheduled-tasks in http-routes.ts.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
  deleteTask,
  setTaskEnabled,
  getTaskRuns,
  validateTaskInput,
  schedulerTick,
  getDefaultExecutors,
  type CreateTaskInput,
  type UpdateTaskInput,
  type TaskType,
} from "../scheduled-tasks.ts";
import { log } from "../logger.ts";

const logger = log.child("api:scheduled-tasks");

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString());
}

/**
 * Handle /api/scheduled-tasks routes.
 * Returns true if the route was handled.
 */
export async function handleScheduledTasksRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const method = req.method ?? "GET";

  // GET /api/scheduled-tasks — list all
  if (pathname === "/api/scheduled-tasks" && method === "GET") {
    const url = new URL(req.url ?? "/", "http://localhost");
    const enabledOnly = url.searchParams.get("enabled") === "true";
    const taskType = url.searchParams.get("type") as TaskType | null;
    const tasks = await listTasks({ enabledOnly: enabledOnly || undefined, taskType: taskType || undefined });
    json(res, 200, { tasks });
    return true;
  }

  // POST /api/scheduled-tasks — create
  if (pathname === "/api/scheduled-tasks" && method === "POST") {
    const body = await readBody(req) as CreateTaskInput;
    const error = validateTaskInput(body);
    if (error) {
      json(res, 400, { error });
      return true;
    }
    const task = await createTask(body);
    logger.info(`Created: ${task.name} (${task.task_type}, ${task.schedule})`);
    json(res, 201, { task });
    return true;
  }

  // POST /api/scheduled-tasks/tick — manually trigger a scheduler tick
  if (pathname === "/api/scheduled-tasks/tick" && method === "POST") {
    const result = await schedulerTick(getDefaultExecutors());
    json(res, 200, { result });
    return true;
  }

  // Routes with task ID: /api/scheduled-tasks/:id
  const idMatch = pathname.match(/^\/api\/scheduled-tasks\/([0-9a-f-]{36})$/);
  if (idMatch) {
    const id = idMatch[1];

    // GET /api/scheduled-tasks/:id
    if (method === "GET") {
      const task = await getTask(id);
      if (!task) { json(res, 404, { error: "task not found" }); return true; }
      json(res, 200, { task });
      return true;
    }

    // PATCH /api/scheduled-tasks/:id
    if (method === "PATCH") {
      const body = await readBody(req) as UpdateTaskInput;
      if (body.schedule) {
        try {
          const { parseCron } = await import("../types/formation-heartbeats");
          parseCron(body.schedule);
        } catch (err) {
          json(res, 400, { error: `invalid schedule: ${err instanceof Error ? err.message : String(err)}` });
          return true;
        }
      }
      const task = await updateTask(id, body);
      if (!task) { json(res, 404, { error: "task not found" }); return true; }
      json(res, 200, { task });
      return true;
    }

    // DELETE /api/scheduled-tasks/:id
    if (method === "DELETE") {
      const deleted = await deleteTask(id);
      if (!deleted) { json(res, 404, { error: "task not found" }); return true; }
      json(res, 200, { ok: true });
      return true;
    }

    return false;
  }

  // POST /api/scheduled-tasks/:id/toggle
  const toggleMatch = pathname.match(/^\/api\/scheduled-tasks\/([0-9a-f-]{36})\/toggle$/);
  if (toggleMatch && method === "POST") {
    const id = toggleMatch[1];
    const body = await readBody(req) as { enabled: boolean };
    const task = await setTaskEnabled(id, !!body.enabled);
    if (!task) { json(res, 404, { error: "task not found" }); return true; }
    json(res, 200, { task });
    return true;
  }

  // GET /api/scheduled-tasks/:id/runs
  const runsMatch = pathname.match(/^\/api\/scheduled-tasks\/([0-9a-f-]{36})\/runs$/);
  if (runsMatch && method === "GET") {
    const id = runsMatch[1];
    const url = new URL(req.url ?? "/", "http://localhost");
    const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
    const runs = await getTaskRuns(id, Math.min(limit, 100));
    json(res, 200, { runs });
    return true;
  }

  return false;
}
