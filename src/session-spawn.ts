/**
 * Session Spawn — ELLIE-942
 *
 * Sub-agent session spawning with thread binding, memory arc assignment,
 * and cost attribution. Inspired by OpenClaw's sessions_spawn tool but
 * integrated with Ellie's Forest memory arcs, channel routing, and
 * formation cost tracking.
 *
 * Design decisions:
 *   - In-memory registry (like dispatch-queue) — no new DB tables needed
 *   - Arc mode: "inherit" (default) shares parent arc, "fork" creates child arc
 *   - Thread binding reuses existing DeliveryContext from parent
 *   - Cost rollup queries formation_costs by child session IDs
 *   - Announcement is push-based: child completion triggers parent notification
 *
 * Refinements (ELLIE-948–953):
 *   - ELLIE-948: Depth enforcement (max depth 2)
 *   - ELLIE-949: killChildrenForParent() cascade kill
 *   - ELLIE-951: Registry GC (prune completed spawns)
 */

import { log } from "./logger.ts";
import type {
  SpawnOpts,
  SpawnResult,
  SpawnRecord,
  SpawnState,
  SpawnAnnouncement,
  SpawnCostRollup,
  DeliveryContext,
  ArcMode,
} from "./types/session-spawn.ts";
import {
  persistSpawnRecord,
  updateSpawnState,
  pruneDbSpawnRecords,
  loadActiveSpawnRecords,
  recoverStaleSpawns,
} from "./spawn-registry-db.ts";

const logger = log.child("session-spawn");

// ── Constants ───────────────────────────────────────────────

const DEFAULT_TIMEOUT_SECONDS = 600; // 10 minutes — bumped from 300 (ELLIE-1421: dev agents need headroom)
const MAX_CHILDREN_PER_PARENT = 5;
const MAX_SPAWN_DEPTH = 2; // ELLIE-948: max nesting depth (0=child, 1=grandchild)
const GC_AGE_MS = 10 * 60_000; // ELLIE-951: prune completed spawns older than 10 minutes

// ── In-Memory Registry ──────────────────────────────────────

const registry = new Map<string, SpawnRecord>();
const parentIndex = new Map<string, Set<string>>();

export function _getRegistryForTesting(): Map<string, SpawnRecord> {
  return registry;
}

export function _clearRegistryForTesting(): void {
  registry.clear();
  parentIndex.clear();
}

// ── Registry Operations ─────────────────────────────────────

function addToRegistry(record: SpawnRecord): void {
  registry.set(record.id, record);
  let children = parentIndex.get(record.parentSessionId);
  if (!children) {
    children = new Set();
    parentIndex.set(record.parentSessionId, children);
  }
  children.add(record.id);
}

function removeFromRegistry(id: string): void {
  const record = registry.get(id);
  if (!record) return;
  registry.delete(id);
  const children = parentIndex.get(record.parentSessionId);
  if (children) {
    children.delete(id);
    if (children.size === 0) parentIndex.delete(record.parentSessionId);
  }
}

function updateRecord(id: string, updates: Partial<SpawnRecord>): SpawnRecord | null {
  const record = registry.get(id);
  if (!record) return null;
  Object.assign(record, updates);
  return record;
}

// ── Spawn ───────────────────────────────────────────────────

/**
 * Spawn a sub-agent session.
 *
 * Creates a SpawnRecord, enforces concurrency limits and depth limits,
 * and returns a result the parent can use to track the child.
 *
 * Does NOT dispatch the child agent — the caller (orchestration-dispatch)
 * is responsible for actually creating the agent session using dispatchAgent().
 * This separation keeps session-spawn focused on bookkeeping.
 */
export function spawnSession(opts: SpawnOpts): SpawnResult {
  const depth = opts.depth ?? 0;

  // ELLIE-948: Enforce max spawn depth
  if (depth > MAX_SPAWN_DEPTH) {
    logger.warn("Spawn rejected: max depth exceeded", {
      parentSessionId: opts.parentSessionId,
      depth,
      maxDepth: MAX_SPAWN_DEPTH,
    });
    return {
      success: false,
      spawnId: "",
      childSessionKey: "",
      error: `Max spawn depth (${MAX_SPAWN_DEPTH}) exceeded (depth=${depth})`,
    };
  }

  // Enforce max children per parent
  const existingChildren = parentIndex.get(opts.parentSessionId);
  const activeCount = existingChildren
    ? [...existingChildren].filter((id) => {
        const r = registry.get(id);
        return r && (r.state === "pending" || r.state === "running");
      }).length
    : 0;

  if (activeCount >= MAX_CHILDREN_PER_PARENT) {
    logger.warn("Spawn rejected: max children reached", {
      parentSessionId: opts.parentSessionId,
      activeCount,
      max: MAX_CHILDREN_PER_PARENT,
    });
    return {
      success: false,
      spawnId: "",
      childSessionKey: "",
      error: `Max concurrent children (${MAX_CHILDREN_PER_PARENT}) reached for parent session`,
    };
  }

  const spawnId = crypto.randomUUID();
  const childSessionKey = `agent:${opts.targetAgentName}:subagent:${spawnId}`;
  const arcMode: ArcMode = opts.arcMode ?? "inherit";

  const record: SpawnRecord = {
    id: spawnId,
    parentSessionId: opts.parentSessionId,
    parentAgentName: opts.parentAgentName,
    childSessionId: childSessionKey,
    childSessionKey,
    targetAgentName: opts.targetAgentName,
    task: opts.task,
    state: "pending",
    arcMode,
    arcId: opts.parentArcId ?? null,
    deliveryContext: opts.deliveryContext ?? null,
    threadBound: opts.threadBind ?? false,
    workItemId: opts.workItemId ?? null,
    createdAt: Date.now(),
    endedAt: null,
    resultText: null,
    error: null,
    timeoutSeconds: opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
    depth,
  };

  addToRegistry(record);

  // ELLIE-954: Write-through to DB (fire-and-forget)
  persistSpawnRecord(record).catch((err) => logger.warn("DB write-through failed", { err: (err as Error).message }));

  logger.info("Session spawned", {
    spawnId,
    parent: opts.parentAgentName,
    child: opts.targetAgentName,
    arcMode,
    depth,
    threadBound: record.threadBound,
  });

  return {
    success: true,
    spawnId,
    childSessionKey,
  };
}

// ── State Transitions ───────────────────────────────────────

export function markRunning(spawnId: string, childSessionId?: string): SpawnRecord | null {
  const updates: Partial<SpawnRecord> = { state: "running" };
  if (childSessionId) updates.childSessionId = childSessionId;
  const record = updateRecord(spawnId, updates);
  if (record) updateSpawnState(spawnId, "running", { childSessionId }).catch((err) => logger.warn("DB write-through failed", { err: (err as Error).message }));
  return record;
}

export function markCompleted(
  spawnId: string,
  resultText?: string,
): SpawnRecord | null {
  const endedAt = Date.now();
  const record = updateRecord(spawnId, {
    state: "completed",
    endedAt,
    resultText: resultText ?? null,
  });
  if (record) updateSpawnState(spawnId, "completed", { resultText: resultText ?? null, endedAt }).catch((err) => logger.warn("DB write-through failed", { err: (err as Error).message }));
  return record;
}

export function markFailed(spawnId: string, error: string): SpawnRecord | null {
  const endedAt = Date.now();
  const record = updateRecord(spawnId, {
    state: "failed",
    endedAt,
    error,
  });
  if (record) updateSpawnState(spawnId, "failed", { error, endedAt }).catch((err) => logger.warn("DB write-through failed", { err: (err as Error).message }));
  return record;
}

export function markTimedOut(spawnId: string): SpawnRecord | null {
  const endedAt = Date.now();
  const record = updateRecord(spawnId, {
    state: "timed_out",
    endedAt,
    error: "Session spawn timed out",
  });
  if (record) updateSpawnState(spawnId, "timed_out", { error: "Session spawn timed out", endedAt }).catch((err) => logger.warn("DB write-through failed", { err: (err as Error).message }));
  return record;
}

// ── Queries ─────────────────────────────────────────────────

export function getSpawnRecord(spawnId: string): SpawnRecord | null {
  return registry.get(spawnId) ?? null;
}

export function getChildrenForParent(parentSessionId: string): SpawnRecord[] {
  const childIds = parentIndex.get(parentSessionId);
  if (!childIds) return [];
  return [...childIds]
    .map((id) => registry.get(id))
    .filter((r): r is SpawnRecord => r !== undefined);
}

export function getActiveChildCount(parentSessionId: string): number {
  const children = getChildrenForParent(parentSessionId);
  return children.filter((r) => r.state === "pending" || r.state === "running").length;
}

export function getRegistrySize(): number {
  return registry.size;
}

// ── ELLIE-949: Cascade Kill ─────────────────────────────────

/**
 * Kill all active children for a parent session.
 * Marks pending/running spawns as failed with a cascade kill reason.
 * Returns the IDs of killed spawns.
 */
export function killChildrenForParent(parentSessionId: string, reason?: string): string[] {
  const children = getChildrenForParent(parentSessionId);
  const killed: string[] = [];
  const killReason = reason || "Parent session terminated (cascade kill)";

  for (const child of children) {
    if (child.state === "pending" || child.state === "running") {
      markFailed(child.id, killReason);
      killed.push(child.id);
      logger.info("Cascade kill: child terminated", {
        spawnId: child.id,
        target: child.targetAgentName,
        parent: parentSessionId,
      });
    }
  }

  if (killed.length > 0) {
    logger.info("Cascade kill complete", { parent: parentSessionId, killed: killed.length });
  }

  return killed;
}

// ── Timeout Check ───────────────────────────────────────────

/**
 * Check all running spawns for timeouts. Returns IDs of timed-out spawns.
 * Intended to be called periodically (e.g., every 30s from a periodic task).
 */
export function checkTimeouts(): string[] {
  const now = Date.now();
  const timedOut: string[] = [];

  for (const [id, record] of registry) {
    if (record.state !== "running" && record.state !== "pending") continue;
    const deadline = record.createdAt + record.timeoutSeconds * 1000;
    if (now >= deadline) {
      markTimedOut(id);
      timedOut.push(id);
      logger.warn("Spawn timed out", {
        spawnId: id,
        target: record.targetAgentName,
        timeoutSeconds: record.timeoutSeconds,
      });
    }
  }

  return timedOut;
}

// ── ELLIE-951: Registry GC ──────────────────────────────────

/**
 * Prune completed, failed, and timed_out spawns older than GC_AGE_MS.
 * Prevents unbounded memory growth in the in-memory registry.
 * Returns the number of records pruned.
 */
export function pruneCompletedSpawns(maxAgeMs: number = GC_AGE_MS): number {
  const now = Date.now();
  let pruned = 0;

  for (const [id, record] of registry) {
    if (record.state === "pending" || record.state === "running") continue;
    const age = now - (record.endedAt ?? record.createdAt);
    if (age >= maxAgeMs) {
      removeFromRegistry(id);
      pruned++;
    }
  }

  if (pruned > 0) {
    logger.info("Registry GC: pruned completed spawns", { pruned, remaining: registry.size });
    // ELLIE-954: Also prune from DB
    pruneDbSpawnRecords(maxAgeMs).catch((err) => logger.warn("DB write-through failed", { err: (err as Error).message }));
  }

  return pruned;
}

// ── ELLIE-954: Startup Recovery ──────────────────────────────

/**
 * Recover spawn registry from the database on relay startup.
 * 1. Marks stale spawns (past timeout) as failed in DB
 * 2. Loads remaining active spawns into the in-memory registry
 * Returns the number of records recovered.
 */
export async function recoverSpawnRegistry(): Promise<{ recovered: number; staleMarked: number }> {
  const staleMarked = await recoverStaleSpawns();
  const activeRecords = await loadActiveSpawnRecords();

  for (const record of activeRecords) {
    // Only add if not already in registry (idempotent)
    if (!registry.has(record.id)) {
      addToRegistry(record);
    }
  }

  if (activeRecords.length > 0 || staleMarked > 0) {
    logger.info("Spawn registry recovered from DB", {
      recovered: activeRecords.length,
      staleMarked,
      registrySize: registry.size,
    });
  }

  return { recovered: activeRecords.length, staleMarked };
}

// ── Announcement Builder ────────────────────────────────────

/**
 * Build an announcement payload for a completed/failed spawn.
 * The caller is responsible for delivering this to the parent's channel.
 */
export function buildAnnouncement(
  spawnId: string,
  costCents: number = 0,
): SpawnAnnouncement | null {
  const record = registry.get(spawnId);
  if (!record) return null;

  const durationMs = record.endedAt
    ? record.endedAt - record.createdAt
    : Date.now() - record.createdAt;

  return {
    spawnId: record.id,
    childSessionKey: record.childSessionKey,
    targetAgentName: record.targetAgentName,
    state: record.state,
    resultText: record.resultText,
    error: record.error,
    costCents,
    durationMs,
  };
}

// ── Cost Rollup ─────────────────────────────────────────────

/**
 * Build a cost rollup for all children of a parent session.
 * Takes an async fetcher so we don't couple to formation-costs directly.
 */
export async function buildCostRollup(
  parentSessionId: string,
  fetchChildCosts: (childSessionIds: string[]) => Promise<
    Array<{
      sessionId: string;
      costCents: number;
      inputTokens: number;
      outputTokens: number;
    }>
  >,
): Promise<SpawnCostRollup> {
  const children = getChildrenForParent(parentSessionId);
  if (children.length === 0) {
    return {
      parentSessionId,
      totalCostCents: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      childCount: 0,
      children: [],
    };
  }

  const childSessionIds = children.map((c) => c.childSessionId);
  const costs = await fetchChildCosts(childSessionIds);

  const costMap = new Map(costs.map((c) => [c.sessionId, c]));

  const childDetails = children.map((child) => {
    const cost = costMap.get(child.childSessionId);
    return {
      spawnId: child.id,
      targetAgentName: child.targetAgentName,
      costCents: cost?.costCents ?? 0,
      inputTokens: cost?.inputTokens ?? 0,
      outputTokens: cost?.outputTokens ?? 0,
    };
  });

  return {
    parentSessionId,
    totalCostCents: childDetails.reduce((sum, c) => sum + c.costCents, 0),
    totalInputTokens: childDetails.reduce((sum, c) => sum + c.inputTokens, 0),
    totalOutputTokens: childDetails.reduce((sum, c) => sum + c.outputTokens, 0),
    childCount: children.length,
    children: childDetails,
  };
}

// ── Arc Resolution ──────────────────────────────────────────

/**
 * Resolve the memory arc ID for a spawned child.
 *
 * - "inherit": returns the parent's arc ID (child writes to same arc)
 * - "fork": calls createArc to create a child arc with parent reference
 *
 * Takes createArc as a parameter to avoid coupling to ellie-forest directly.
 */
export async function resolveArcForSpawn(
  spawnId: string,
  createArc: (opts: {
    name: string;
    category?: string;
    direction?: string;
    summary?: string;
    owner_id?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<{ id: string }>,
): Promise<string | null> {
  const record = registry.get(spawnId);
  if (!record) return null;

  if (record.arcMode === "inherit") {
    return record.arcId;
  }

  // Fork: create a new arc linked to the parent
  const arc = await createArc({
    name: `${record.targetAgentName} sub-task: ${record.task.slice(0, 50)}`,
    category: "work",
    direction: "exploring",
    summary: `Forked from parent ${record.parentAgentName} session ${record.parentSessionId.slice(0, 8)}`,
    metadata: {
      source: "session_spawn",
      parent_session_id: record.parentSessionId,
      parent_arc_id: record.arcId,
      spawn_id: record.id,
    },
  });

  record.arcId = arc.id;
  return arc.id;
}

// ── Thread Binding Helper ───────────────────────────────────

/**
 * Extract the delivery context needed for thread binding from a parent session.
 * The caller should pass this into SpawnOpts.deliveryContext.
 */
export function captureDeliveryContext(opts: {
  channel: string;
  chatId?: number | string;
  threadId?: string;
  webhookId?: string;
  webhookToken?: string;
  guildId?: string;
}): DeliveryContext {
  return {
    channel: opts.channel,
    chatId: opts.chatId,
    threadId: opts.threadId,
    webhookId: opts.webhookId,
    webhookToken: opts.webhookToken,
    guildId: opts.guildId,
  };
}
