/**
 * Working Memory API — HTTP endpoint handlers (ELLIE-538)
 *
 * Endpoints:
 *   POST  /api/working-memory/init        — create/reinitialize a session's working memory
 *   PATCH /api/working-memory/update      — merge section updates + increment turn
 *   GET   /api/working-memory/read        — fetch active working memory
 *   POST  /api/working-memory/checkpoint  — increment turn without changing sections
 *   POST  /api/working-memory/promote     — archive + write decision_log to Forest
 */

import {
  initWorkingMemory,
  updateWorkingMemory,
  readWorkingMemory,
  checkpointWorkingMemory,
  archiveWorkingMemory,
  type WorkingMemorySections,
} from "../working-memory.ts";
import { writeMemory } from "../../../ellie-forest/src/index.ts";
import { log } from "../logger.ts";
import type { ApiRequest, ApiResponse } from "./types.ts";

const logger = log.child("working-memory-api");

// ── POST /api/working-memory/init ────────────────────────────────────────────

/**
 * Create or reinitialize working memory for a session+agent pair.
 *
 * Body: { session_id, agent, sections?, channel? }
 */
export async function workingMemoryInitEndpoint(
  req: ApiRequest,
  res: ApiResponse,
): Promise<void> {
  const { session_id, agent, sections, channel } = req.body ?? {};

  if (!session_id || typeof session_id !== "string") {
    res.status(400).json({ error: "Missing required field: session_id" });
    return;
  }
  if (!agent || typeof agent !== "string") {
    res.status(400).json({ error: "Missing required field: agent" });
    return;
  }

  try {
    const record = await initWorkingMemory({
      session_id,
      agent,
      sections: sections as WorkingMemorySections | undefined,
      channel: channel as string | undefined,
    });

    res.json({
      success: true,
      working_memory: record,
    });
  } catch (error) {
    logger.error("init failed", { session_id, agent }, error);
    res.status(500).json({ error: "Internal server error" });
  }
}

// ── PATCH /api/working-memory/update ─────────────────────────────────────────

/**
 * Merge section updates into the active working memory.
 *
 * Body: { session_id, agent, sections }
 * Returns 404 if no active record exists.
 */
export async function workingMemoryUpdateEndpoint(
  req: ApiRequest,
  res: ApiResponse,
): Promise<void> {
  const { session_id, agent, sections } = req.body ?? {};

  if (!session_id || typeof session_id !== "string") {
    res.status(400).json({ error: "Missing required field: session_id" });
    return;
  }
  if (!agent || typeof agent !== "string") {
    res.status(400).json({ error: "Missing required field: agent" });
    return;
  }
  if (!sections || typeof sections !== "object") {
    res.status(400).json({ error: "Missing required field: sections" });
    return;
  }

  try {
    const record = await updateWorkingMemory({
      session_id,
      agent,
      sections: sections as Partial<WorkingMemorySections>,
    });

    if (!record) {
      res.status(404).json({
        error: "No active working memory found for this session+agent",
      });
      return;
    }

    res.json({
      success: true,
      working_memory: record,
    });
  } catch (error) {
    logger.error("update failed", { session_id, agent }, error);
    res.status(500).json({ error: "Internal server error" });
  }
}

// ── GET /api/working-memory/read ─────────────────────────────────────────────

/**
 * Read the active working memory for a session+agent.
 *
 * Query: ?session_id=...&agent=...
 * Returns 404 if no active record exists.
 */
export async function workingMemoryReadEndpoint(
  req: ApiRequest,
  res: ApiResponse,
): Promise<void> {
  const session_id = (req.query?.session_id ?? (req.body as any)?.session_id) as string | undefined;
  const agent      = (req.query?.agent      ?? (req.body as any)?.agent)      as string | undefined;

  if (!session_id) {
    res.status(400).json({ error: "Missing required param: session_id" });
    return;
  }
  if (!agent) {
    res.status(400).json({ error: "Missing required param: agent" });
    return;
  }

  try {
    const record = await readWorkingMemory({ session_id, agent });

    if (!record) {
      res.status(404).json({
        error: "No active working memory found for this session+agent",
      });
      return;
    }

    res.json({
      success: true,
      working_memory: record,
    });
  } catch (error) {
    logger.error("read failed", { session_id, agent }, error);
    res.status(500).json({ error: "Internal server error" });
  }
}

// ── POST /api/working-memory/checkpoint ──────────────────────────────────────

/**
 * Increment turn_number without changing sections.
 *
 * Body: { session_id, agent }
 * Returns 404 if no active record exists.
 */
export async function workingMemoryCheckpointEndpoint(
  req: ApiRequest,
  res: ApiResponse,
): Promise<void> {
  const { session_id, agent } = req.body ?? {};

  if (!session_id || typeof session_id !== "string") {
    res.status(400).json({ error: "Missing required field: session_id" });
    return;
  }
  if (!agent || typeof agent !== "string") {
    res.status(400).json({ error: "Missing required field: agent" });
    return;
  }

  try {
    const record = await checkpointWorkingMemory({ session_id, agent });

    if (!record) {
      res.status(404).json({
        error: "No active working memory found for this session+agent",
      });
      return;
    }

    res.json({
      success: true,
      working_memory: record,
    });
  } catch (error) {
    logger.error("checkpoint failed", { session_id, agent }, error);
    res.status(500).json({ error: "Internal server error" });
  }
}

// ── POST /api/working-memory/promote ─────────────────────────────────────────

/**
 * Archive working memory and write decision_log to the Forest knowledge store.
 *
 * Body: { session_id, agent, scope_path?, work_item_id? }
 *   scope_path    — Forest scope to write to (default: "2/1" = ellie-dev)
 *   work_item_id  — associated Plane work item (for Forest metadata)
 *
 * Returns 404 if no active record exists.
 * Returns 200 with promoted=false if decision_log is empty (still archives).
 */
export async function workingMemoryPromoteEndpoint(
  req: ApiRequest,
  res: ApiResponse,
): Promise<void> {
  const {
    session_id,
    agent,
    scope_path = "2/1",
    work_item_id,
  } = req.body ?? {};

  if (!session_id || typeof session_id !== "string") {
    res.status(400).json({ error: "Missing required field: session_id" });
    return;
  }
  if (!agent || typeof agent !== "string") {
    res.status(400).json({ error: "Missing required field: agent" });
    return;
  }

  try {
    const record = await archiveWorkingMemory({ session_id, agent });

    if (!record) {
      res.status(404).json({
        error: "No active working memory found for this session+agent",
      });
      return;
    }

    const decisionLog = record.sections.decision_log?.trim();
    let promotedMemoryId: string | null = null;

    if (decisionLog) {
      const content = `[Working memory from ${agent} / ${session_id}]\n\n${decisionLog}`;
      const memory = await writeMemory({
        content,
        type: "decision",
        scope_path: scope_path as string,
        confidence: 0.8,
        metadata: {
          source: "working_memory_promote",
          working_memory_id: record.id,
          agent,
          turn_number: record.turn_number,
          ...(work_item_id ? { work_item_id } : {}),
        },
      });
      promotedMemoryId = memory.id;
    }

    res.json({
      success: true,
      promoted: !!promotedMemoryId,
      promoted_memory_id: promotedMemoryId,
      working_memory: record,
    });
  } catch (error) {
    logger.error("promote failed", { session_id, agent }, error);
    res.status(500).json({ error: "Internal server error" });
  }
}
