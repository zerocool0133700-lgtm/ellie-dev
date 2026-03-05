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
 */

import { sql } from "../../ellie-forest/src/index.ts";

/** Normalize a record returned from postgres.js: parse sections if still a string. */
function normalize(record: WorkingMemoryRecord): WorkingMemoryRecord {
  return {
    ...record,
    sections: typeof record.sections === "string"
      ? JSON.parse(record.sections as unknown as string)
      : record.sections,
  };
}
import { log } from "./logger.ts";

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
}): Promise<WorkingMemoryRecord> {
  const { session_id, agent, sections = {}, channel = null } = opts;

  // Archive any existing active record for this session+agent
  await sql`
    UPDATE working_memory
    SET archived_at = NOW()
    WHERE session_id = ${session_id}
      AND agent      = ${agent}
      AND archived_at IS NULL
  `;

  const [record] = await sql<WorkingMemoryRecord[]>`
    INSERT INTO working_memory (session_id, agent, sections, channel)
    VALUES (
      ${session_id},
      ${agent},
      ${sql.json(sections)},
      ${channel}
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
 * Returns null if no active record exists for the pair.
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
    RETURNING *
  `;

  return record ? normalize(record) : null;
}

/**
 * Read the active working memory for a session+agent.
 * Returns null when no active record exists.
 */
export async function readWorkingMemory(opts: {
  session_id: string;
  agent: string;
}): Promise<WorkingMemoryRecord | null> {
  const { session_id, agent } = opts;

  const [record] = await sql<WorkingMemoryRecord[]>`
    SELECT * FROM working_memory
    WHERE session_id = ${session_id}
      AND agent      = ${agent}
      AND archived_at IS NULL
  `;

  return record ? normalize(record) : null;
}

/**
 * Checkpoint: increment turn_number without changing sections.
 * Used to mark progress milestones without a content update.
 * Returns null if no active record exists.
 */
export async function checkpointWorkingMemory(opts: {
  session_id: string;
  agent: string;
}): Promise<WorkingMemoryRecord | null> {
  const { session_id, agent } = opts;

  const [record] = await sql<WorkingMemoryRecord[]>`
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
