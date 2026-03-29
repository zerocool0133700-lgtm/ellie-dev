/**
 * Docker Executor — ELLIE-1136
 *
 * Container lifecycle manager for overnight autonomous agent work.
 * Calls Docker Engine API directly via Unix socket — does NOT shell out to docker CLI.
 *
 * Follows the same patterns as src/docker-sandbox.ts:
 *   - node:http for Unix socket communication
 *   - Structured logging via logger.child()
 *   - Resource limits + security hardening
 */

import http from "node:http";
import { log } from "../logger.ts";

const logger = log.child("docker-executor");

const DOCKER_SOCKET = "/var/run/docker.sock";
const OVERNIGHT_IMAGE = "ghcr.io/anthropics/claude-code:latest";
const CONTAINER_PREFIX = "ellie-overnight-";

const DEFAULT_MEMORY_LIMIT = 536870912;  // 512MB
const DEFAULT_NANOCPUS = 1000000000;      // 1 CPU

// ── Env Whitelist ────────────────────────────────────────────

const ENV_WHITELIST = new Set([
  "RUNTIME",
  "AGENT",
  "GH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "REPO_URL",
  "FEATURE_BRANCH",
  "AGENT_JOB_ID",
  "PROMPT",
  "SYSTEM_PROMPT",
]);

// ── Types ────────────────────────────────────────────────────

export interface ContainerEnvOpts {
  GH_TOKEN?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  REPO_URL?: string;
  FEATURE_BRANCH?: string;
  AGENT_JOB_ID?: string;
  PROMPT?: string;
  SYSTEM_PROMPT?: string;
  [key: string]: string | undefined;
}

export interface OvernightTaskResult {
  exitCode: number;
  logs: string;
}

// ── Docker API Client ────────────────────────────────────────

function dockerApi(
  method: string,
  path: string,
  body?: Record<string, unknown> | null,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        path,
        method,
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk; });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: data ? JSON.parse(data) : {} });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: { message: data } });
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error("Docker API timeout")); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Docker API call that returns raw response body (for logs endpoint which returns plain text).
 */
function dockerApiRaw(
  method: string,
  path: string,
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        path,
        method,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          // Docker log stream uses multiplexed format: 8-byte header per frame
          // Byte 0: stream type (1=stdout, 2=stderr), Bytes 4-7: frame size (big-endian)
          let text = "";
          let offset = 0;
          while (offset + 8 <= buf.length) {
            const size = buf.readUInt32BE(offset + 4);
            if (offset + 8 + size > buf.length) break;
            text += buf.subarray(offset + 8, offset + 8 + size).toString("utf8");
            offset += 8 + size;
          }
          // Fallback: if no multiplexed frames were parsed, treat as plain text
          if (!text && buf.length > 0) {
            text = buf.toString("utf8");
          }
          resolve({ status: res.statusCode ?? 0, data: text });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error("Docker API timeout")); });
    req.end();
  });
}

// ── Build Helpers ────────────────────────────────────────────

/**
 * Build container env array with ONLY whitelisted variables.
 * Always includes RUNTIME=agent-job and AGENT=claude-code.
 * Rejects any key not in the whitelist.
 */
export function buildContainerEnv(opts: ContainerEnvOpts): string[] {
  const env: string[] = [
    "RUNTIME=agent-job",
    "AGENT=claude-code",
  ];

  for (const [key, value] of Object.entries(opts)) {
    if (value === undefined || value === null) continue;
    if (!ENV_WHITELIST.has(key)) {
      logger.warn(`Rejected non-whitelisted env var: ${key}`);
      continue;
    }
    // Skip RUNTIME and AGENT since we hardcode them above
    if (key === "RUNTIME" || key === "AGENT") continue;
    env.push(`${key}=${value}`);
  }

  return env;
}

/**
 * Build HostConfig for overnight container.
 * Resource limits are configurable via OVERNIGHT_MEMORY_LIMIT and OVERNIGHT_CPU_LIMIT env vars.
 */
export function buildHostConfig(volumeName: string): Record<string, unknown> {
  const memoryLimit = process.env.OVERNIGHT_MEMORY_LIMIT
    ? parseInt(process.env.OVERNIGHT_MEMORY_LIMIT, 10)
    : DEFAULT_MEMORY_LIMIT;

  const nanoCpus = process.env.OVERNIGHT_CPU_LIMIT
    ? parseInt(process.env.OVERNIGHT_CPU_LIMIT, 10)
    : DEFAULT_NANOCPUS;

  return {
    Memory: memoryLimit,
    NanoCpus: nanoCpus,
    AutoRemove: true,
    SecurityOpt: ["no-new-privileges"],
    Binds: [`${volumeName}:/home/coding-agent`],
  };
}

// ── Volume Lifecycle ─────────────────────────────────────────

/**
 * Create a Docker volume for task workspace.
 */
export async function createVolume(name: string): Promise<void> {
  const { status, data } = await dockerApi("POST", "/volumes/create", {
    Name: name,
    Labels: { "ellie.overnight": "true" },
  });
  if (status !== 201 && status !== 200) {
    throw new Error(`Docker volume create failed (${status}): ${data?.message}`);
  }
  logger.info(`Volume created: ${name}`);
}

/**
 * Remove a Docker volume.
 */
export async function removeVolume(name: string): Promise<void> {
  const { status, data } = await dockerApi("DELETE", `/volumes/${encodeURIComponent(name)}`);
  if (status === 204 || status === 200 || status === 404) {
    logger.info(`Volume removed: ${name}`);
    return;
  }
  throw new Error(`Docker volume remove failed (${status}): ${data?.message}`);
}

// ── Container Lifecycle ──────────────────────────────────────

/**
 * Create and start an overnight agent container.
 * Returns the container ID.
 */
export async function launchContainer(
  containerName: string,
  volumeName: string,
  env: string[],
): Promise<string> {
  const hostConfig = buildHostConfig(volumeName);

  const createRes = await dockerApi("POST",
    `/containers/create?name=${encodeURIComponent(containerName)}`,
    {
      Image: OVERNIGHT_IMAGE,
      Env: env,
      Labels: {
        "ellie.overnight": "true",
        "ellie.container-name": containerName,
      },
      HostConfig: hostConfig,
    },
  );

  if (createRes.status !== 201) {
    throw new Error(`Docker create failed (${createRes.status}): ${createRes.data?.message}`);
  }

  const containerId = createRes.data.Id;

  const startRes = await dockerApi("POST", `/containers/${containerId}/start`);
  if (startRes.status !== 204 && startRes.status !== 304) {
    // Clean up on failed start
    await dockerApi("DELETE", `/containers/${containerId}?force=true`).catch(() => {});
    throw new Error(`Docker start failed (${startRes.status}): ${startRes.data?.message}`);
  }

  logger.info(`Launched container: ${containerName}`, { containerId });
  return containerId;
}

/**
 * Wait for a container to exit. Returns the exit code.
 */
export async function waitForContainer(containerId: string): Promise<number> {
  // Docker wait API blocks until container stops
  const { status, data } = await new Promise<{ status: number; data: any }>((resolve, reject) => {
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        path: `/containers/${containerId}/wait`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk; });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: body ? JSON.parse(body) : {} });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: { message: body } });
          }
        });
      },
    );
    req.on("error", reject);
    // Long timeout — container may run for hours
    req.setTimeout(8 * 60 * 60_000, () => {
      req.destroy();
      reject(new Error("Docker wait timeout (8h)"));
    });
    req.end();
  });

  if (status !== 200) {
    throw new Error(`Docker wait failed (${status}): ${data?.message}`);
  }

  const exitCode = data.StatusCode ?? -1;
  logger.info(`Container exited`, { containerId, exitCode });
  return exitCode;
}

/**
 * Get container logs (stdout + stderr combined).
 */
export async function getContainerLogs(containerId: string): Promise<string> {
  const { status, data } = await dockerApiRaw("GET",
    `/containers/${containerId}/logs?stdout=true&stderr=true&timestamps=false`,
  );
  if (status !== 200) {
    logger.warn(`Failed to get logs for ${containerId}`, { status });
    return "";
  }
  return data;
}

/**
 * Check if a container is currently running.
 */
export async function isContainerRunning(containerId: string): Promise<boolean> {
  try {
    const { status, data } = await dockerApi("GET", `/containers/${containerId}/json`);
    if (status !== 200) return false;
    return data?.State?.Running === true;
  } catch {
    return false;
  }
}

// ── Full Lifecycle ───────────────────────────────────────────

/**
 * Run a complete overnight task: create volume, launch container, wait, collect logs, cleanup.
 */
export async function runOvernightTask(
  taskId: string,
  env: string[],
): Promise<OvernightTaskResult> {
  const containerName = `${CONTAINER_PREFIX}${taskId}`;
  const volumeName = `${CONTAINER_PREFIX}vol-${taskId}`;

  try {
    await createVolume(volumeName);
    const containerId = await launchContainer(containerName, volumeName, env);

    logger.info(`Task ${taskId} running`, { containerId, containerName });

    const exitCode = await waitForContainer(containerId);

    // Logs may fail if AutoRemove already cleaned up the container
    let logs = "";
    try {
      logs = await getContainerLogs(containerId);
    } catch (err) {
      logger.warn(`Could not retrieve logs for ${taskId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return { exitCode, logs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Task ${taskId} failed`, { error: message });
    return { exitCode: -1, logs: `Error: ${message}` };
  } finally {
    // Always try to clean up the volume
    try {
      await removeVolume(volumeName);
    } catch {
      // Volume cleanup is best-effort
    }
  }
}

// ── Exports for Testing ──────────────────────────────────────

export { dockerApi as _dockerApiForTesting };
export const CONSTANTS = {
  DOCKER_SOCKET,
  OVERNIGHT_IMAGE,
  CONTAINER_PREFIX,
  DEFAULT_MEMORY_LIMIT,
  DEFAULT_NANOCPUS,
  ENV_WHITELIST: [...ENV_WHITELIST],
} as const;
