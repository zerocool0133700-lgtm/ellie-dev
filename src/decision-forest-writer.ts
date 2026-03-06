/**
 * Decision Forest Writer — ELLIE-585
 *
 * Writes agent decisions from work sessions to the Forest via Bridge API.
 * Follows the same pattern as post-mortem Forest writes (ELLIE-584):
 *   - Pure builder function (zero deps, testable)
 *   - Effectful writer with injectable fetch (fire-and-forget)
 */

import { RELAY_BASE_URL } from "./relay-config.ts";
import { log } from "./logger.ts";
import { trackMemoryId } from "./dispatch-memory-tracker.ts";

const logger = log.child("decision-forest-writer");

const BRIDGE_KEY = "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ForestDecision {
  content: string;
  type: "decision";
  scope_path: string;
  confidence: number;
  metadata: {
    work_item_id: string;
    source: string;
    agent?: string;
    session_id?: string;
  };
}

// ── Pure: Build Forest decision payload ──────────────────────────────────────

/**
 * Build a Forest decision node from work session decision data.
 * Pure function — no side effects, fully testable.
 */
export function buildForestDecision(
  workItemId: string,
  message: string,
  agent?: string,
  sessionId?: string,
): ForestDecision {
  const metadata: ForestDecision["metadata"] = {
    work_item_id: workItemId,
    source: "work-session",
    agent,
  };
  if (sessionId) metadata.session_id = sessionId;
  return {
    content: `${workItemId}: ${message}`,
    type: "decision",
    scope_path: "2/1",
    confidence: 0.8,
    metadata,
  };
}

// ── Effectful: Write decision to Forest via Bridge ───────────────────────────

/**
 * Write a work session decision to the Forest via Bridge API.
 * Fire-and-forget: failures are logged but never block the main handler.
 */
export async function writeDecisionToForest(
  workItemId: string,
  message: string,
  agent?: string,
  fetchFn: typeof fetch = fetch,
  sessionId?: string,
): Promise<boolean> {
  try {
    const decision = buildForestDecision(workItemId, message, agent, sessionId);
    const resp = await fetchFn(`${RELAY_BASE_URL}/api/bridge/write`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-key": BRIDGE_KEY,
      },
      body: JSON.stringify(decision),
    });

    if (!resp.ok) {
      logger.warn("writeDecisionToForest: Bridge write failed", {
        status: resp.status,
        workItemId,
      });
      return false;
    }

    // ELLIE-632: Track memory ID for dispatch cross-referencing
    try {
      const body = await resp.json() as { memory_id?: string };
      if (body.memory_id) {
        trackMemoryId(workItemId, body.memory_id);
      }
    } catch {
      // Response parsing failure is non-fatal
    }

    logger.info("Decision written to Forest", { workItemId, agent });
    return true;
  } catch (err) {
    logger.warn("writeDecisionToForest failed (non-fatal)", err);
    return false;
  }
}
