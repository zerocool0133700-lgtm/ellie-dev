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
const ISOLATED_NETWORK_NAME = "ellie-overnight-isolated";

const DEFAULT_MEMORY_LIMIT = 536870912;  // 512MB
const DEFAULT_NANOCPUS = 1000000000;      // 1 CPU
const DEFAULT_CONTAINER_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const TIMEOUT_EXIT_CODE = -2;

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
    SecurityOpt: ["no-new-privileges"],
    NetworkMode: ISOLATED_NETWORK_NAME,
    ExtraHosts: [
      "host.docker.internal:0.0.0.0",
      "gateway.docker.internal:0.0.0.0",
    ],
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

// ── Network Isolation (ELLIE-1144) ──────────────────────────

let networkReady = false;

/**
 * Ensure the isolated Docker network exists.
 * Creates a bridge network that allows outbound internet but blocks host access
 * via ExtraHosts DNS poisoning (set in buildHostConfig).
 *
 * Idempotent — safe to call multiple times.
 */
export async function ensureIsolatedNetwork(): Promise<void> {
  if (networkReady) return;

  // Check if network already exists
  const inspectRes = await dockerApi("GET",
    `/networks/${encodeURIComponent(ISOLATED_NETWORK_NAME)}`,
  );
  if (inspectRes.status === 200) {
    networkReady = true;
    logger.info(`Isolated network already exists: ${ISOLATED_NETWORK_NAME}`);
    return;
  }

  // Create the network
  const createRes = await dockerApi("POST", "/networks/create", {
    Name: ISOLATED_NETWORK_NAME,
    Driver: "bridge",
    Labels: { "ellie.overnight": "true" },
    Options: {
      "com.docker.network.bridge.enable_icc": "false",
    },
  });

  if (createRes.status !== 201 && createRes.status !== 200) {
    logger.error(`Failed to create isolated network (${createRes.status}): ${createRes.data?.message}`);
    throw new Error(`Docker network create failed (${createRes.status}): ${createRes.data?.message}`);
  }

  networkReady = true;
  logger.info(`Created isolated network: ${ISOLATED_NETWORK_NAME}`);
}

/**
 * Reset the network-ready flag. Exported for testing only.
 */
export function _resetNetworkReadyForTesting(): void {
  networkReady = false;
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
  // Ensure isolated network exists before launching (ELLIE-1144)
  await ensureIsolatedNetwork();

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

/**
 * Force-kill and remove a container. Used for timeout enforcement.
 * Idempotent — safe to call on already-stopped or nonexistent containers.
 */
export async function killContainer(containerId: string): Promise<void> {
  try {
    await dockerApi("POST", `/containers/${containerId}/kill`);
    logger.info("Killed container", { containerId });
  } catch (err) {
    // Container may already be stopped — that's fine
    logger.debug("Kill container failed (may already be stopped)", {
      containerId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // Force remove after kill
  try {
    await dockerApi("DELETE", `/containers/${containerId}?force=true`);
  } catch {
    // Best-effort cleanup
  }
}

// ── Full Lifecycle ───────────────────────────────────────────

/**
 * Run a complete overnight task: create volume, launch container, wait, collect logs, cleanup.
 * Enforces a container timeout — hung containers are killed after the deadline.
 * Timeout is configurable via OVERNIGHT_CONTAINER_TIMEOUT env var (milliseconds).
 */
export async function runOvernightTask(
  taskId: string,
  env: string[],
  opts?: { timeoutMs?: number },
): Promise<OvernightTaskResult> {
  const containerName = `${CONTAINER_PREFIX}${taskId}`;
  const volumeName = `${CONTAINER_PREFIX}vol-${taskId}`;
  const timeoutMs = opts?.timeoutMs
    ?? (process.env.OVERNIGHT_CONTAINER_TIMEOUT
      ? parseInt(process.env.OVERNIGHT_CONTAINER_TIMEOUT, 10)
      : DEFAULT_CONTAINER_TIMEOUT_MS);

  let containerId = "";

  try {
    await createVolume(volumeName);
    containerId = await launchContainer(containerName, volumeName, env);

    logger.info(`Task ${taskId} running`, { containerId, containerName, timeoutMs });

    // Race: container completion vs timeout
    const exitCode = await waitWithTimeout(containerId, timeoutMs, taskId);

    // Collect logs before removing the container
    let logs = "";
    try {
      logs = await getContainerLogs(containerId);
    } catch (err) {
      logger.warn(`Could not retrieve logs for ${taskId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Remove container now that logs have been collected
    try {
      await dockerApi("DELETE", `/containers/${containerId}?force=true`);
      logger.debug(`Removed container after log collection`, { containerId });
    } catch {
      // Best-effort cleanup — container may already be gone (timeout path)
    }

    if (exitCode === TIMEOUT_EXIT_CODE) {
      logs += `\n[ellie] Container killed after ${Math.round(timeoutMs / 1000)}s timeout`;
    }

    return { exitCode, logs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Task ${taskId} failed`, { error: message });
    // If we have a container, ensure it's cleaned up
    if (containerId) {
      await killContainer(containerId).catch(() => {});
    }
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

/**
 * Wait for container with a timeout. Kills the container if it exceeds the deadline.
 */
async function waitWithTimeout(
  containerId: string,
  timeoutMs: number,
  taskId: string,
): Promise<number> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;

  const timeoutPromise = new Promise<number>((resolve) => {
    timeoutHandle = setTimeout(async () => {
      timedOut = true;
      logger.warn(`Task ${taskId} timed out after ${Math.round(timeoutMs / 1000)}s — killing container`, {
        containerId,
      });
      await killContainer(containerId);
      resolve(TIMEOUT_EXIT_CODE);
    }, timeoutMs);
  });

  try {
    const exitCode = await Promise.race([
      waitForContainer(containerId),
      timeoutPromise,
    ]);
    return exitCode;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

// ── Exports for Testing ──────────────────────────────────────

export { dockerApi as _dockerApiForTesting };
export const CONSTANTS = {
  DOCKER_SOCKET,
  OVERNIGHT_IMAGE,
  CONTAINER_PREFIX,
  ISOLATED_NETWORK_NAME,
  DEFAULT_MEMORY_LIMIT,
  DEFAULT_NANOCPUS,
  DEFAULT_CONTAINER_TIMEOUT_MS,
  TIMEOUT_EXIT_CODE,
  ENV_WHITELIST: [...ENV_WHITELIST],
} as const;
