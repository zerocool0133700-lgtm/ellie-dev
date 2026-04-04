/**
 * Working Memory — session-scoped state layer (ELLIE-538)
 *
 * Sits between the ephemeral context window and permanent Forest/Supabase storage.
 * Survives context compression; makes every session resumable by default.
 *
 * Each working memory record holds 7 sections (all optional strings):
 *   session_identity    — agent name, ticket ID, channel
 *   task_stack          — ordered todo list with active task highlighted
 *   conversation_thread — narrative summary (not transcript)
 *   investigation_state — hypotheses, files read, current exploration
 *   decision_log        — choices made this session with reasoning
 *   context_anchors     — specific details that must survive (errors, line numbers)
 *   resumption_prompt   — agent-written continuation note for its future self
 *
 * ELLIE-923 Phase 1: Pre-compaction snapshots
 *   When context pressure reaches critical levels, working memory is automatically
 *   snapshotted to Forest before compaction occurs. This preserves full session state
 *   and enables recovery if context compression loses critical information.
 */

import { sql } from "../../ellie-forest/src/index.ts";
import { log } from "./logger.ts";
import { hashToInt64 } from "./advisory-lock-hash.ts";

/** Normalize a record returned from postgres.js: parse sections if still a string. */
function normalize(record: WorkingMemoryRecord): WorkingMemoryRecord {
  return {
    ...record,
    sections: typeof record.sections === "string"
      ? JSON.parse(record.sections as unknown as string)
      : record.sections,
  };
}

const logger = log.child("working-memory");

/** Maximum active sessions to keep per agent (oldest pruned on init). */
export const MAX_ACTIVE_SESSIONS_PER_AGENT = 10;

// ── Types ────────────────────────────────────────────────────────────────────

export interface WorkingMemorySections {
  session_identity?: string;
  task_stack?: string;
  conversation_thread?: string;
  investigation_state?: string;
  decision_log?: string;
  context_anchors?: string;
  resumption_prompt?: string;
}

export interface WorkingMemoryRecord {
  id: string;
  session_id: string;
  agent: string;
  sections: WorkingMemorySections;
  turn_number: number;
  channel: string | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  safeguard_locked: boolean;
  safeguard_locked_at: Date | null;
}

// ── Core operations ──────────────────────────────────────────────────────────

/**
 * Initialize working memory for a session+agent pair.
 *
 * If an active record already exists for the pair, it is archived first.
 * Oldest sessions beyond MAX_ACTIVE_SESSIONS_PER_AGENT are pruned.
 */
export async function initWorkingMemory(opts: {
  session_id: string;
  agent: string;
  sections?: WorkingMemorySections;
  channel?: string;
  thread_id?: string;  // ELLIE-1374
}): Promise<WorkingMemoryRecord> {
  const { session_id, agent, sections = {}, channel = null, thread_id = null } = opts;

  // Archive any existing active record for this session+agent
  await sql`
    UPDATE working_memory
    SET archived_at = NOW()
    WHERE session_id = ${session_id}
      AND agent      = ${agent}
      AND archived_at IS NULL
  `;

  const [record] = await sql<WorkingMemoryRecord[]>`
    INSERT INTO working_memory (session_id, agent, sections, channel, thread_id)
    VALUES (
      ${session_id},
      ${agent},
      ${sql.json(sections)},
      ${channel},
      ${thread_id}
    )
    RETURNING *
  `;

  // Prune oldest sessions beyond the per-agent limit
  await sql`
    UPDATE working_memory
    SET archived_at = NOW()
    WHERE id IN (
      SELECT id FROM working_memory
      WHERE agent       = ${agent}
        AND archived_at IS NULL
      ORDER BY created_at DESC
      OFFSET ${MAX_ACTIVE_SESSIONS_PER_AGENT}
    )
  `;

  logger.info("Initialized", { session_id, agent });
  return normalize(record);
}

/**
 * Update one or more sections and increment turn_number.
 * Uses JSONB merge (||) so untouched sections are preserved.
 * Returns null if no active record exists or if record is safeguard-locked.
 *
 * ELLIE-922 Critical Issue #3: Rejects updates when safeguard_locked is TRUE
 * to prevent verification race conditions during compaction safeguard checks.
 */
export async function updateWorkingMemory(opts: {
  session_id: string;
  agent: string;
  sections: Partial<WorkingMemorySections>;
}): Promise<WorkingMemoryRecord | null> {
  const { session_id, agent, sections } = opts;

  const [record] = await sql<WorkingMemoryRecord[]>`
    UPDATE working_memory
    SET
      sections    = sections || ${sql.json(sections)},
      turn_number = turn_number + 1,
      updated_at  = NOW()
    WHERE session_id = ${session_id}
      AND agent      = ${agent}
      AND archived_at IS NULL
      AND safeguard_locked = FALSE
    RETURNING *
  `;

  if (!record) {
    // Check if rejection was due to safeguard lock
    const [lockedCheck] = await sql<{ safeguard_locked: boolean }[]>`
      SELECT safeguard_locked
      FROM working_memory
      WHERE session_id = ${session_id}
        AND agent = ${agent}
        AND archived_at IS NULL
    `;
    if (lockedCheck?.safeguard_locked) {
      logger.warn("Update rejected — safeguard locked", { session_id, agent });
    }
  }

  return record ? normalize(record) : null;
}

/**
 * Read the active working memory for a session+agent.
 * Returns null when no active record exists.
 */
export async function readWorkingMemory(opts: {
  session_id?: string;
  agent: string;
  thread_id?: string;  // ELLIE-1374
}): Promise<WorkingMemoryRecord | null> {
  const { session_id, agent } = opts;

  const sessionFilter = session_id
    ? sql`AND session_id = ${session_id}`
    : sql``;

  const threadFilter = opts.thread_id
    ? sql`AND thread_id = ${opts.thread_id}`
    : sql``;

  const [record] = await sql<WorkingMemoryRecord[]>`
    SELECT * FROM working_memory
    WHERE agent = ${agent}
      AND archived_at IS NULL
      ${sessionFilter}
      ${threadFilter}
    ORDER BY updated_at DESC
    LIMIT 1
  `;

  return record ? normalize(record) : null;
}

/**
 * Checkpoint: increment turn_number without changing sections.
 * Used to mark progress milestones without a content update.
 * Returns null if no active record exists.
 *
 * ELLIE-922 Critical Issue #1: Uses PostgreSQL advisory locks to prevent
 * concurrent checkpoint race conditions that could corrupt turn_number.
 *
 * ELLIE-925 Fix: Wrapped in sql.begin() transaction to ensure advisory lock
 * is held for the duration of the UPDATE query. Previously used pg_advisory_xact_lock
 * in a separate query which auto-committed and released the lock before the UPDATE ran.
 */
export async function checkpointWorkingMemory(opts: {
  session_id: string;
  agent: string;
}): Promise<WorkingMemoryRecord | null> {
  const { session_id, agent } = opts;

  // Generate a stable lock key from session_id + agent
  // ELLIE-925: Use consolidated FNV-1a hash for consistency with session-compaction.ts
  const lockKey = hashToInt64(`${session_id}:${agent}`);

  // ELLIE-925 Fix: Wrap lock + update in a single transaction
  // pg_advisory_xact_lock is transaction-scoped and auto-releases on commit/rollback
  return await sql.begin(async (txn) => {
    // Acquire advisory lock (held until transaction completes)
    await txn`SELECT pg_advisory_xact_lock(${lockKey})`;

    // Update with lock held
    const [record] = await txn<WorkingMemoryRecord[]>`
      UPDATE working_memory
      SET
        turn_number = turn_number + 1,
        updated_at  = NOW()
      WHERE session_id = ${session_id}
        AND agent      = ${agent}
        AND archived_at IS NULL
      RETURNING *
    `;

    return record ? normalize(record) : null;
  });
}


/**
 * Archive the active working memory record.
 * Returns the final state (including decision_log) so the caller can
 * promote decisions to the Forest knowledge store.
 * Returns null if no active record exists.
 */
export async function archiveWorkingMemory(opts: {
  session_id: string;
  agent: string;
}): Promise<WorkingMemoryRecord | null> {
  const { session_id, agent } = opts;

  const [record] = await sql<WorkingMemoryRecord[]>`
    UPDATE working_memory
    SET archived_at = NOW()
    WHERE session_id = ${session_id}
      AND agent      = ${agent}
      AND archived_at IS NULL
    RETURNING *
  `;

  return record ? normalize(record) : null;
}

/**
 * Auto-archive records that have been idle for more than 24 hours.
 * Intended to be called by a periodic scheduler (ELLIE-540).
 * Returns the number of records archived.
 */
export async function archiveIdleWorkingMemory(): Promise<number> {
  const archived = await sql<{ id: string }[]>`
    UPDATE working_memory
    SET archived_at = NOW()
    WHERE archived_at IS NULL
      AND updated_at < NOW() - INTERVAL '24 hours'
    RETURNING id
  `;
  return archived.length;
}

/**
 * Create a pre-compaction snapshot of working memory to Forest (ELLIE-923 Phase 1).
 *
 * Captures the full working memory state before context compression occurs,
 * so session context can be recovered if compaction loses critical state.
 * Returns the memory ID of the written snapshot, or null if no active record exists.
 *
 * ELLIE-922 Critical Issue #2: Snapshot creation is now atomic with safeguard lock.
 * ELLIE-922 Critical Issue #3: Sets safeguard_locked flag to prevent agent updates
 * during the verification window.
 *
 * @param opts.session_id     — session to snapshot
 * @param opts.agent          — agent name
 * @param opts.work_item_id   — optional work item ID for Forest metadata
 * @param opts.scope_path     — Forest scope (default: "2/1" = ellie-dev)
 */
export async function snapshotWorkingMemoryToForest(opts: {
  session_id: string;
  agent: string;
  work_item_id?: string;
  scope_path?: string;
}): Promise<string | null> {
  const { session_id, agent, work_item_id, scope_path = "2/1" } = opts;

  // ELLIE-925 Fix: Wrap lock + read in transaction to prevent TOCTOU race
  // Lock working memory and read it atomically to prevent updates between lock and read
  const record = await sql.begin(async (txn) => {
    // Lock the working memory record
    await txn`
      UPDATE working_memory
      SET safeguard_locked = TRUE,
          safeguard_locked_at = NOW()
      WHERE session_id = ${session_id}
        AND agent = ${agent}
        AND archived_at IS NULL
    `;

    // Read the locked record (same transaction, atomic with the UPDATE)
    const [rec] = await txn<WorkingMemoryRecord[]>`
      SELECT *
      FROM working_memory
      WHERE session_id = ${session_id}
        AND agent = ${agent}
        AND archived_at IS NULL
    `;

    return rec ? normalize(rec) : null;
  });

  if (!record) {
    logger.warn("Snapshot skipped — no active working memory", { session_id, agent });
    // No need to unlock — the transaction rolled back and lock wasn't committed
    return null;
  }

  // Import writeMemory here to avoid circular dependency
  const { writeMemory } = await import("../../ellie-forest/src/index.ts");

  // Build snapshot content with all sections
  const sectionLines: string[] = [];
  const sections = record.sections;

  if (sections.session_identity) {
    sectionLines.push(`## Session Identity\n${sections.session_identity}`);
  }
  if (sections.task_stack) {
    sectionLines.push(`## Task Stack\n${sections.task_stack}`);
  }
  if (sections.conversation_thread) {
    sectionLines.push(`## Conversation Thread\n${sections.conversation_thread}`);
  }
  if (sections.investigation_state) {
    sectionLines.push(`## Investigation State\n${sections.investigation_state}`);
  }
  if (sections.decision_log) {
    sectionLines.push(`## Decision Log\n${sections.decision_log}`);
  }
  if (sections.context_anchors) {
    sectionLines.push(`## Context Anchors\n${sections.context_anchors}`);
  }
  if (sections.resumption_prompt) {
    sectionLines.push(`## Resumption Prompt\n${sections.resumption_prompt}`);
  }

  const content = [
    `Pre-compaction snapshot of working memory for ${agent} session ${session_id}`,
    `Turn ${record.turn_number} | Channel: ${record.channel ?? "unknown"}`,
    `Captured at: ${new Date().toISOString()}`,
    "",
    ...sectionLines,
  ].join("\n");

  // Write to Forest with working_memory_snapshot tag
  const memory = await writeMemory({
    content,
    type: "finding",
    scope_path,
    confidence: 0.9,
    tags: ["working_memory_snapshot", `agent:${agent}`],
    metadata: {
      snapshot_source: "pre_compaction",
      working_memory_id: record.id,
      session_id,
      agent,
      turn_number: record.turn_number,
      channel: record.channel,
      ...(work_item_id ? { work_item_id } : {}),
    },
  });

  logger.info("Snapshot written to Forest", {
    session_id,
    agent,
    memory_id: memory.id,
    turn_number: record.turn_number,
  });

  return memory.id;
}

/**
 * Unlock safeguard protection after verification completes (ELLIE-922).
 *
 * Critical Issue #3 fix: This unlocks working memory after the compaction
 * safeguard verification window completes (either verification passed or
 * rollback completed). Must be called by the verification logic to restore
 * normal operation.
 */
export async function unlockSafeguard(opts: {
  session_id: string;
  agent: string;
}): Promise<void> {
  const { session_id, agent } = opts;

  await sql`
    UPDATE working_memory
    SET safeguard_locked = FALSE,
        safeguard_locked_at = NULL
    WHERE session_id = ${session_id}
      AND agent = ${agent}
      AND archived_at IS NULL
  `;

  logger.info("Safeguard unlocked", { session_id, agent });
}

/**
 * Auto-unlock safeguard locks older than 1 hour (ELLIE-1420).
 *
 * If the compaction verification process crashes after setting safeguard_locked,
 * the session is permanently locked. This function is called hourly to clear
 * stale locks and restore normal operation.
 *
 * Returns the number of sessions unlocked.
 */
export async function autoUnlockStaleSafeguards(): Promise<number> {
  const unlocked = await sql<{ id: string; session_id: string; agent: string }[]>`
    UPDATE working_memory
    SET safeguard_locked = FALSE,
        safeguard_locked_at = NULL
    WHERE safeguard_locked = TRUE
      AND archived_at IS NULL
      AND safeguard_locked_at IS NOT NULL
      AND safeguard_locked_at < NOW() - INTERVAL '1 hour'
    RETURNING id, session_id, agent
  `;

  for (const row of unlocked) {
    logger.warn("Auto-unlocked stale safeguard", {
      id: row.id,
      session_id: row.session_id,
      agent: row.agent,
    });
  }

  return unlocked.length;
}

/**
 * Get working memory context_anchors from other threads for cross-thread awareness.
 * ELLIE-1374
 */
export async function getSiblingThreadMemories(
  agent: string,
  currentThreadId: string,
): Promise<Array<{ thread_id: string; context_anchors: string | null }>> {
  const rows = await sql`
    SELECT thread_id, sections->'context_anchors' as context_anchors
    FROM working_memory
    WHERE agent = ${agent}
      AND thread_id IS NOT NULL
      AND thread_id != ${currentThreadId}
      AND archived_at IS NULL
  `;
  return rows as unknown as Array<{ thread_id: string; context_anchors: string | null }>;
}

// ── Relay wiring (ELLIE-541) ─────────────────────────────────────────────────

/**
 * Fetch the active working memory from DB and populate the in-process cache.
 *
 * Call this before buildPrompt() so the prompt gets session context injected
 * automatically. No-ops when session_id is null or no active record exists.
 * Errors propagate to the caller — wrap in try/catch to keep the prompt path
 * non-blocking when the DB is unreachable.
 */
export async function primeWorkingMemoryCache(
  session_id: string | null,
  agent: string,
): Promise<void> {
  if (!session_id) return;
  const record = await readWorkingMemory({ session_id, agent });
  if (record) setWorkingMemoryCache(agent, record);
}

// ── In-process cache (ELLIE-539) ─────────────────────────────────────────────
//
// Mirrors the River doc cache pattern from prompt-builder.ts.
// The relay/message handler populates this cache before calling buildPrompt(),
// so the prompt-builder can read working memory synchronously.
//
// Cache key: agent name (e.g. "dev", "research", "general")
// One active record per agent at a time.

const _workingMemoryCache = new Map<string, WorkingMemoryRecord>();

/**
 * Store the active working memory record for an agent.
 * Called by the relay/message handler before building a prompt.
 */
export function setWorkingMemoryCache(agent: string, record: WorkingMemoryRecord): void {
  _workingMemoryCache.set(agent, record);
}

/**
 * Get the cached working memory for an agent.
 * Returns null if no record is cached.
 * Called synchronously by buildPrompt().
 */
export function getCachedWorkingMemory(agent: string): WorkingMemoryRecord | null {
  return _workingMemoryCache.get(agent) ?? null;
}

/**
 * Clear all cached working memory records.
 * Used in tests and on session teardown.
 */
export function clearWorkingMemoryCache(): void {
  _workingMemoryCache.clear();
}

/**
 * Inject a working memory record into the cache for testing.
 * Bypasses the DB so tests can control prompt content without live data.
 *
 * @param agent    — agent name (e.g. "dev")
 * @param sections — partial sections to inject
 */
export function _injectWorkingMemoryForTesting(
  agent: string,
  sections: Partial<WorkingMemorySections>,
): void {
  const record: WorkingMemoryRecord = {
    id: `test-${agent}`,
    session_id: `test-session-${agent}`,
    agent,
    sections: sections as WorkingMemorySections,
    turn_number: 0,
    channel: null,
    created_at: new Date(),
    updated_at: new Date(),
    archived_at: null,
    safeguard_locked: false,
    safeguard_locked_at: null,
  };
  _workingMemoryCache.set(agent, record);
}
