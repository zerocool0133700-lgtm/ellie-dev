/**
 * Docker Sandbox REST API — ELLIE-979/980
 *
 * Container management + live stats streaming for dashboard.
 * Mounted under /api/sandbox in http-routes.ts.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createContainer,
  stopContainer,
  removeContainer,
  inspectContainer,
  listContainers,
  listContainersWithStats,
  getContainerStats,
  execInContainer,
  cleanupExpiredContainers,
  isDockerAvailable,
  type CreateContainerOpts,
} from "../docker-sandbox.ts";
import { log } from "../logger.ts";

const logger = log.child("api:sandbox");

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
 * Handle /api/sandbox routes. Returns true if handled.
 */
export async function handleSandboxRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const method = req.method ?? "GET";

  // GET /api/sandbox/health — Docker availability check
  if (pathname === "/api/sandbox/health" && method === "GET") {
    const available = await isDockerAvailable();
    json(res, 200, { docker: available });
    return true;
  }

  // GET /api/sandbox/containers — list all sandbox containers
  if (pathname === "/api/sandbox/containers" && method === "GET") {
    const containers = await listContainers();
    json(res, 200, { containers });
    return true;
  }

  // GET /api/sandbox/containers/stats — list with live stats (for dashboard)
  if (pathname === "/api/sandbox/containers/stats" && method === "GET") {
    const containers = await listContainersWithStats();
    json(res, 200, { containers });
    return true;
  }

  // POST /api/sandbox/containers — create a new container
  if (pathname === "/api/sandbox/containers" && method === "POST") {
    const body = await readBody(req) as CreateContainerOpts;
    try {
      const container = await createContainer(body);
      json(res, 201, { container });
    } catch (err: any) {
      json(res, 500, { error: err.message });
    }
    return true;
  }

  // POST /api/sandbox/cleanup — remove expired containers
  if (pathname === "/api/sandbox/cleanup" && method === "POST") {
    const removed = await cleanupExpiredContainers();
    json(res, 200, { removed });
    return true;
  }

  // Routes with container name: /api/sandbox/containers/:name
  const nameMatch = pathname.match(/^\/api\/sandbox\/containers\/([a-zA-Z0-9_.-]+)$/);
  if (nameMatch) {
    const name = nameMatch[1];

    // GET /api/sandbox/containers/:name — inspect
    if (method === "GET") {
      const info = await inspectContainer(name);
      if (!info) { json(res, 404, { error: "container not found" }); return true; }
      json(res, 200, { container: info });
      return true;
    }

    // DELETE /api/sandbox/containers/:name — remove
    if (method === "DELETE") {
      try {
        await removeContainer(name);
        json(res, 200, { ok: true });
      } catch (err: any) {
        json(res, 500, { error: err.message });
      }
      return true;
    }

    return false;
  }

  // POST /api/sandbox/containers/:name/stop
  const stopMatch = pathname.match(/^\/api\/sandbox\/containers\/([a-zA-Z0-9_.-]+)\/stop$/);
  if (stopMatch && method === "POST") {
    try {
      await stopContainer(stopMatch[1]);
      json(res, 200, { ok: true });
    } catch (err: any) {
      json(res, 500, { error: err.message });
    }
    return true;
  }

  // POST /api/sandbox/containers/:name/exec
  const execMatch = pathname.match(/^\/api\/sandbox\/containers\/([a-zA-Z0-9_.-]+)\/exec$/);
  if (execMatch && method === "POST") {
    const body = await readBody(req) as { cmd: string; timeout?: number };
    if (!body.cmd) { json(res, 400, { error: "cmd required" }); return true; }
    try {
      const result = await execInContainer(execMatch[1], body.cmd, body.timeout || 10_000);
      json(res, 200, { result });
    } catch (err: any) {
      json(res, 500, { error: err.message });
    }
    return true;
  }

  // GET /api/sandbox/containers/:name/stats
  const statsMatch = pathname.match(/^\/api\/sandbox\/containers\/([a-zA-Z0-9_.-]+)\/stats$/);
  if (statsMatch && method === "GET") {
    const stats = await getContainerStats(statsMatch[1]);
    if (!stats) { json(res, 404, { error: "container not found or not running" }); return true; }
    json(res, 200, { stats });
    return true;
  }

  // GET /api/sandbox/stream — SSE stream for live container monitoring (ELLIE-980)
  if (pathname === "/api/sandbox/stream" && method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let closed = false;
    req.on("close", () => { closed = true; });

    const send = (event: string, data: unknown) => {
      if (closed) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch { /* client disconnected */ }
    };

    // Initial push
    const containers = await listContainersWithStats();
    send("containers", containers);

    // Poll every 3 seconds
    const interval = setInterval(async () => {
      if (closed) { clearInterval(interval); return; }
      try {
        const c = await listContainersWithStats();
        send("containers", c);
      } catch { /* ignore */ }
    }, 3_000);

    // Keepalive every 15 seconds
    const keepalive = setInterval(() => {
      if (closed) { clearInterval(keepalive); return; }
      send("ping", {});
    }, 15_000);

    req.on("close", () => {
      clearInterval(interval);
      clearInterval(keepalive);
    });

    return true;
  }

  return false;
}
