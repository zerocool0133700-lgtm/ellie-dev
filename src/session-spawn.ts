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

const logger = log.child("session-spawn");

// ── Constants ───────────────────────────────────────────────

const DEFAULT_TIMEOUT_SECONDS = 300; // 5 minutes
const MAX_CHILDREN_PER_PARENT = 5;

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
 * Creates a SpawnRecord, enforces concurrency limits, and returns
 * a result the parent can use to track the child.
 *
 * Does NOT dispatch the child agent — the caller (orchestration-dispatch)
 * is responsible for actually creating the agent session using dispatchAgent().
 * This separation keeps session-spawn focused on bookkeeping.
 */
export function spawnSession(opts: SpawnOpts): SpawnResult {
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
  };

  addToRegistry(record);

  logger.info("Session spawned", {
    spawnId,
    parent: opts.parentAgentName,
    child: opts.targetAgentName,
    arcMode,
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
  return updateRecord(spawnId, updates);
}

export function markCompleted(
  spawnId: string,
  resultText?: string,
): SpawnRecord | null {
  return updateRecord(spawnId, {
    state: "completed",
    endedAt: Date.now(),
    resultText: resultText ?? null,
  });
}

export function markFailed(spawnId: string, error: string): SpawnRecord | null {
  return updateRecord(spawnId, {
    state: "failed",
    endedAt: Date.now(),
    error,
  });
}

export function markTimedOut(spawnId: string): SpawnRecord | null {
  return updateRecord(spawnId, {
    state: "timed_out",
    endedAt: Date.now(),
    error: "Session spawn timed out",
  });
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
