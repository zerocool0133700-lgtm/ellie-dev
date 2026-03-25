/**
 * Docker Sandbox — ELLIE-978
 *
 * Container lifecycle manager for agent sandbox execution.
 * Calls Docker Engine API directly via Unix socket — does NOT shell out to docker CLI.
 *
 * Features:
 *   - Create/start/stop/remove containers with resource limits
 *   - Get container stats (CPU, memory, network)
 *   - Execute commands inside containers
 *   - List and inspect containers
 *   - Auto-cleanup expired containers
 */

import http from "node:http";
import { log } from "./logger.ts";

const logger = log.child("docker-sandbox");

const DOCKER_SOCKET = "/var/run/docker.sock";
const CONTAINER_PREFIX = "ellie-sandbox-";
const DEFAULT_IMAGE = "ubuntu:24.04";
const DEFAULT_MEMORY_LIMIT = 512 * 1024 * 1024; // 512MB
const DEFAULT_CPU_QUOTA = 100_000; // 1 CPU
const MAX_CONTAINER_AGE_MS = 4 * 60 * 60_000; // 4 hours

// ── Types ────────────────────────────────────────────────────

export interface ContainerInfo {
  id: string;
  name: string;
  state: "running" | "exited" | "paused" | "dead" | "created" | "restarting";
  status: string;
  image: string;
  created: string;
  agent?: string;
  workItemId?: string;
}

export interface ContainerStats {
  cpu: number;        // percentage
  memUsage: number;   // bytes
  memLimit: number;   // bytes
  memPercent: number;  // percentage
  netRx: number;      // bytes
  netTx: number;      // bytes
}

export interface CreateContainerOpts {
  name?: string;
  image?: string;
  agent?: string;
  workItemId?: string;
  env?: string[];
  memoryLimit?: number;
  cpuQuota?: number;
  workingDir?: string;
  binds?: string[];
  cmd?: string[];
}

export interface ExecResult {
  stdout: string;
  exitCode: number | null;
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

// ── Container Lifecycle ──────────────────────────────────────

/**
 * Create and start a sandbox container.
 */
export async function createContainer(opts: CreateContainerOpts = {}): Promise<ContainerInfo> {
  const name = opts.name || `${CONTAINER_PREFIX}${Date.now().toString(36)}`;
  const image = opts.image || DEFAULT_IMAGE;

  // Ensure image exists locally
  const inspectRes = await dockerApi("GET", `/images/${encodeURIComponent(image)}/json`);
  if (inspectRes.status !== 200) {
    const [fromImage, tag] = image.includes(":") ? image.split(":") : [image, "latest"];
    const pullRes = await dockerApi("POST", `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`);
    if (pullRes.status !== 200) {
      throw new Error(`Docker pull failed (${pullRes.status}): ${pullRes.data?.message}`);
    }
  }

  const labels: Record<string, string> = { "ellie.sandbox": "true" };
  if (opts.agent) labels["ellie.agent"] = opts.agent;
  if (opts.workItemId) labels["ellie.work-item"] = opts.workItemId;

  const createRes = await dockerApi("POST", `/containers/create?name=${encodeURIComponent(name)}`, {
    Image: image,
    Env: opts.env || [],
    Labels: labels,
    ...(opts.workingDir ? { WorkingDir: opts.workingDir } : {}),
    ...(opts.cmd ? { Cmd: opts.cmd } : { Cmd: ["sleep", "infinity"] }),
    HostConfig: {
      Memory: opts.memoryLimit || DEFAULT_MEMORY_LIMIT,
      CpuQuota: opts.cpuQuota || DEFAULT_CPU_QUOTA,
      CpuPeriod: 100_000,
      NetworkMode: "none", // sandboxed: no network by default
      SecurityOpt: ["no-new-privileges"],
      ...(opts.binds ? { Binds: opts.binds } : {}),
    },
  });

  if (createRes.status !== 201) {
    throw new Error(`Docker create failed (${createRes.status}): ${createRes.data?.message}`);
  }

  const containerId = createRes.data.Id;

  const startRes = await dockerApi("POST", `/containers/${containerId}/start`);
  if (startRes.status !== 204 && startRes.status !== 304) {
    // Clean up failed container
    await dockerApi("DELETE", `/containers/${containerId}?force=true`).catch(() => {});
    throw new Error(`Docker start failed (${startRes.status}): ${startRes.data?.message}`);
  }

  logger.info(`Created: ${name}`, { image, agent: opts.agent, workItemId: opts.workItemId });

  return {
    id: containerId,
    name,
    state: "running",
    status: "Up",
    image,
    created: new Date().toISOString(),
    agent: opts.agent,
    workItemId: opts.workItemId,
  };
}

/**
 * Stop a running container.
 */
export async function stopContainer(nameOrId: string): Promise<void> {
  const { status, data } = await dockerApi("POST", `/containers/${encodeURIComponent(nameOrId)}/stop?t=10`);
  if (status === 204 || status === 304 || status === 404) return;
  throw new Error(`Docker stop failed (${status}): ${data?.message}`);
}

/**
 * Remove a container (force).
 */
export async function removeContainer(nameOrId: string): Promise<void> {
  const { status, data } = await dockerApi("DELETE", `/containers/${encodeURIComponent(nameOrId)}?force=true`);
  if (status === 204 || status === 404) return;
  throw new Error(`Docker remove failed (${status}): ${data?.message}`);
}

/**
 * Inspect a container by name or ID.
 */
export async function inspectContainer(nameOrId: string): Promise<any | null> {
  const { status, data } = await dockerApi("GET", `/containers/${encodeURIComponent(nameOrId)}/json`);
  if (status === 404) return null;
  if (status === 200) return data;
  throw new Error(`Docker inspect failed (${status}): ${data?.message}`);
}

// ── Container Stats ──────────────────────────────────────────

/**
 * Get live stats for a container (CPU, memory, network).
 */
export async function getContainerStats(nameOrId: string): Promise<ContainerStats | null> {
  try {
    const { status, data } = await dockerApi("GET",
      `/containers/${encodeURIComponent(nameOrId)}/stats?stream=false`,
    );
    if (status !== 200 || !data) return null;

    const cpuDelta = (data.cpu_stats?.cpu_usage?.total_usage || 0) - (data.precpu_stats?.cpu_usage?.total_usage || 0);
    const systemDelta = (data.cpu_stats?.system_cpu_usage || 0) - (data.precpu_stats?.system_cpu_usage || 0);
    const numCpus = data.cpu_stats?.online_cpus || 1;
    const cpu = systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;

    const memUsage = data.memory_stats?.usage || 0;
    const memLimit = data.memory_stats?.limit || 0;
    const memPercent = memLimit > 0 ? (memUsage / memLimit) * 100 : 0;

    let netRx = 0, netTx = 0;
    if (data.networks) {
      for (const iface of Object.values(data.networks) as any[]) {
        netRx += iface.rx_bytes || 0;
        netTx += iface.tx_bytes || 0;
      }
    }

    return {
      cpu: Math.round(cpu * 100) / 100,
      memUsage,
      memLimit,
      memPercent: Math.round(memPercent * 100) / 100,
      netRx,
      netTx,
    };
  } catch {
    return null;
  }
}

// ── Container Listing ────────────────────────────────────────

/**
 * List all Ellie sandbox containers.
 */
export async function listContainers(): Promise<ContainerInfo[]> {
  const filters = JSON.stringify({ label: ["ellie.sandbox=true"] });
  const { status, data } = await dockerApi("GET",
    `/containers/json?all=true&filters=${encodeURIComponent(filters)}`,
  );
  if (status !== 200 || !Array.isArray(data)) return [];

  return data.map((c: any) => ({
    id: c.Id,
    name: (c.Names?.[0] || "").replace(/^\//, ""),
    state: c.State,
    status: c.Status,
    image: c.Image,
    created: new Date(c.Created * 1000).toISOString(),
    agent: c.Labels?.["ellie.agent"],
    workItemId: c.Labels?.["ellie.work-item"],
  }));
}

/**
 * List all containers with live stats (for monitoring dashboard).
 */
export async function listContainersWithStats(): Promise<(ContainerInfo & { stats: ContainerStats | null })[]> {
  const containers = await listContainers();

  const withStats = await Promise.all(
    containers.map(async (c) => {
      const stats = c.state === "running" ? await getContainerStats(c.name) : null;
      return { ...c, stats };
    }),
  );

  return withStats;
}

// ── Execute in Container ─────────────────────────────────────

/**
 * Execute a command inside a running container. Returns stdout.
 */
export async function execInContainer(
  nameOrId: string,
  cmd: string,
  timeoutMs = 10_000,
): Promise<ExecResult> {
  const createRes = await dockerApi("POST",
    `/containers/${encodeURIComponent(nameOrId)}/exec`,
    {
      Cmd: ["sh", "-c", cmd],
      AttachStdout: true,
      AttachStderr: true,
    },
  );
  if (createRes.status !== 201 || !createRes.data?.Id) {
    return { stdout: "", exitCode: -1 };
  }

  const execId = createRes.data.Id;

  const buf = await new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("exec timeout")), timeoutMs);
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        path: `/exec/${execId}/start`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
      },
    );
    req.on("error", (err) => { clearTimeout(timer); reject(err); });
    req.write(JSON.stringify({ Detach: false, Tty: false }));
    req.end();
  });

  // Parse Docker multiplexed stream: 8-byte headers
  let stdout = "";
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4);
    if (offset + 8 + size > buf.length) break;
    if (buf[offset] === 1) { // stdout
      stdout += buf.subarray(offset + 8, offset + 8 + size).toString("utf8");
    }
    offset += 8 + size;
  }

  // Get exit code
  const inspectRes = await dockerApi("GET", `/exec/${execId}/json`);
  const exitCode = inspectRes.data?.ExitCode ?? null;

  return { stdout, exitCode };
}

// ── Cleanup ──────────────────────────────────────────────────

/**
 * Remove containers older than MAX_CONTAINER_AGE_MS.
 * Called by periodic task to prevent sandbox accumulation.
 */
export async function cleanupExpiredContainers(): Promise<number> {
  const containers = await listContainers();
  const now = Date.now();
  let removed = 0;

  for (const c of containers) {
    const age = now - new Date(c.created).getTime();
    if (age > MAX_CONTAINER_AGE_MS) {
      try {
        await removeContainer(c.name);
        removed++;
        logger.info(`Cleaned up: ${c.name} (age: ${Math.round(age / 60_000)}min)`);
      } catch (err) {
        logger.warn(`Cleanup failed: ${c.name}`, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return removed;
}

// ── Health Check ─────────────────────────────────────────────

/**
 * Check if Docker is available.
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    const { status } = await dockerApi("GET", "/_ping");
    return status === 200;
  } catch {
    return false;
  }
}

// ── Test Utilities ───────────────────────────────────────────

export { dockerApi as _dockerApiForTesting };
export const CONSTANTS = {
  CONTAINER_PREFIX,
  DEFAULT_IMAGE,
  DEFAULT_MEMORY_LIMIT,
  DEFAULT_CPU_QUOTA,
  MAX_CONTAINER_AGE_MS,
  DOCKER_SOCKET,
} as const;
