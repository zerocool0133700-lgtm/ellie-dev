/**
 * Approval Module
 *
 * Human-in-the-loop confirmations via Telegram inline keyboards.
 * Claude requests approval by including [CONFIRM: description] tags
 * in its response. The relay parses these, shows buttons, and
 * resumes the session with the user's decision.
 */

import { randomUUID } from "crypto";

export interface PendingAction {
  id: string;
  description: string;
  sessionId: string | null;
  chatId: number;
  messageId: number;
  createdAt: number;
}

const EXPIRY_MS = 15 * 60_000; // 15 minutes
const CLEANUP_INTERVAL_MS = 5 * 60_000; // Check every 5 minutes

const pendingActions = new Map<string, PendingAction>();

/**
 * Parse [CONFIRM: ...] tags from Claude's response.
 * Returns the cleaned text and an array of extracted descriptions.
 */
export function extractApprovalTags(response: string): {
  cleanedText: string;
  confirmations: string[];
} {
  const confirmations: string[] = [];
  let cleaned = response;

  for (const match of response.matchAll(/\[CONFIRM:\s*(.+?)\]/gi)) {
    confirmations.push(match[1].trim());
    cleaned = cleaned.replace(match[0], "");
  }

  return { cleanedText: cleaned.trim(), confirmations };
}

/**
 * Store a pending action and return its ID.
 */
export function storePendingAction(
  id: string,
  description: string,
  sessionId: string | null,
  chatId: number,
  messageId: number,
): void {
  pendingActions.set(id, {
    id,
    description,
    sessionId,
    chatId,
    messageId,
    createdAt: Date.now(),
  });
}

export function getPendingAction(id: string): PendingAction | undefined {
  return pendingActions.get(id);
}

export function removePendingAction(id: string): void {
  pendingActions.delete(id);
}

/**
 * Start periodic cleanup of expired pending actions.
 * Call once at startup.
 */
export function startExpiryCleanup(): void {
  setInterval(() => {
    const now = Date.now();
    for (const [id, action] of pendingActions) {
      if (now - action.createdAt > EXPIRY_MS) {
        pendingActions.delete(id);
        console.log(`[approval] Expired action: ${action.description.substring(0, 60)}`);
      }
    }
  }, CLEANUP_INTERVAL_MS);
}
