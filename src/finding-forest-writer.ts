/**
 * Finding Forest Writer — ELLIE-586
 *
 * Writes bug/root-cause discoveries from work sessions to the Forest via Bridge API.
 * Follows the same pattern as decision-forest-writer (ELLIE-585):
 *   - Pure builder function (zero deps, testable)
 *   - Effectful writer with injectable fetch (fire-and-forget)
 */

import { RELAY_BASE_URL } from "./relay-config.ts";
import { log } from "./logger.ts";

const logger = log.child("finding-forest-writer");

const BRIDGE_KEY = "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ForestFindingPayload {
  content: string;
  type: "finding";
  scope_path: string;
  confidence: number;
  metadata: {
    work_item_id: string;
    source: string;
    agent?: string;
  };
}

// ── Pure: Build Forest finding payload ───────────────────────────────────────

/**
 * Build a Forest finding node from work session discovery data.
 * Pure function — no side effects, fully testable.
 *
 * Confidence defaults to 0.7 — findings from active debugging may need
 * verification, unlike decisions which are deliberate choices.
 */
export function buildForestFinding(
  workItemId: string,
  message: string,
  agent?: string,
  confidence: number = 0.7,
): ForestFindingPayload {
  return {
    content: `${workItemId}: ${message}`,
    type: "finding",
    scope_path: "2/1",
    confidence,
    metadata: {
      work_item_id: workItemId,
      source: "work-session",
      agent,
    },
  };
}

// ── Effectful: Write finding to Forest via Bridge ────────────────────────────

/**
 * Write a work session finding to the Forest via Bridge API.
 * Fire-and-forget: failures are logged but never block the main handler.
 */
export async function writeFindingToForest(
  workItemId: string,
  message: string,
  agent?: string,
  confidence?: number,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const finding = buildForestFinding(workItemId, message, agent, confidence);
    const resp = await fetchFn(`${RELAY_BASE_URL}/api/bridge/write`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-key": BRIDGE_KEY,
      },
      body: JSON.stringify(finding),
    });

    if (!resp.ok) {
      logger.warn("writeFindingToForest: Bridge write failed", {
        status: resp.status,
        workItemId,
      });
      return false;
    }

    logger.info("Finding written to Forest", { workItemId, agent });
    return true;
  } catch (err) {
    logger.warn("writeFindingToForest failed (non-fatal)", err);
    return false;
  }
}
