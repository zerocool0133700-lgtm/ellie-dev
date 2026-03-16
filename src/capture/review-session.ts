/**
 * Guided Capture Review Session — ELLIE-776
 * Conversational flow walking through queued capture items one at a time.
 * Pure functions with injected SQL for testability.
 */

import { refineCapture, type RefinementResult } from "./refinement-engine.ts";
import type { CaptureItem, Channel } from "../capture-queue.ts";

// Types

export interface ReviewSession {
  id: string;
  channel: Channel;
  started_at: string;
  items: CaptureItem[];
  current_index: number;
  status: "active" | "complete" | "cancelled";
  approved: string[];
  dismissed: string[];
  skipped: string[];
  refinements: Map<string, RefinementResult>;
}

export type ReviewAction = "approve" | "edit" | "skip" | "dismiss" | "approve_all" | "skip_all";

// Trigger detection

const TRIGGER_PHRASES = [
  "review captures",
  "review capture",
  "capture review",
  "review queue",
  "review river queue",
  "let's review",
  "lets review",
  "review flagged",
];

export function isReviewTrigger(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return TRIGGER_PHRASES.some(p => lower.includes(p));
}

// Action parsing

export function parseReviewAction(text: string): { action: ReviewAction; editContent?: string } | null {
  const lower = text.toLowerCase().trim();

  if (lower === "approve" || lower === "yes" || lower === "y" || lower === "approve it" || lower === "lgtm") {
    return { action: "approve" };
  }
  if (lower === "skip" || lower === "next" || lower === "pass") {
    return { action: "skip" };
  }
  if (lower === "dismiss" || lower === "no" || lower === "n" || lower === "drop" || lower === "remove") {
    return { action: "dismiss" };
  }
  if (lower === "approve all" || lower === "approve remaining" || lower === "approve rest") {
    return { action: "approve_all" };
  }
  if (lower === "skip all" || lower === "skip remaining" || lower === "skip rest" || lower === "done") {
    return { action: "skip_all" };
  }
  if (lower.startsWith("edit ") || lower.startsWith("change to ") || lower.startsWith("update ")) {
    const content = text.slice(text.indexOf(" ") + 1).trim();
    return { action: "edit", editContent: content };
  }

  return null;
}

// Session management (in-memory)

const sessions = new Map<string, ReviewSession>();

export async function startReviewSession(
  sql: any,
  sessionKey: string,
  channel: Channel,
): Promise<ReviewSession | null> {
  // Fetch queued items
  const items = await sql`
    SELECT * FROM capture_queue
    WHERE status IN ('queued', 'refined')
    ORDER BY created_at ASC
  `;

  if (items.length === 0) return null;

  const session: ReviewSession = {
    id: sessionKey,
    channel,
    started_at: new Date().toISOString(),
    items,
    current_index: 0,
    status: "active",
    approved: [],
    dismissed: [],
    skipped: [],
    refinements: new Map(),
  };

  sessions.set(sessionKey, session);
  return session;
}

export function getReviewSession(sessionKey: string): ReviewSession | null {
  return sessions.get(sessionKey) ?? null;
}

export function isReviewActive(sessionKey: string): boolean {
  const s = sessions.get(sessionKey);
  return s?.status === "active";
}

// Get current item and its refinement

export function getCurrentItem(session: ReviewSession): { item: CaptureItem; refinement: RefinementResult } | null {
  if (session.current_index >= session.items.length) return null;

  const item = session.items[session.current_index];
  let refinement = session.refinements.get(item.id);

  if (!refinement) {
    refinement = refineCapture({
      raw_content: item.raw_content,
      channel: item.channel as Channel,
      hint_content_type: item.content_type as any,
    });
    session.refinements.set(item.id, refinement);
  }

  return { item, refinement };
}

// Process an action on the current item

export async function processAction(
  sql: any,
  sessionKey: string,
  action: ReviewAction,
  editContent?: string,
): Promise<{ moved: boolean; finished: boolean; message: string }> {
  const session = sessions.get(sessionKey);
  if (!session || session.status !== "active") {
    return { moved: false, finished: true, message: "No active review session." };
  }

  const current = getCurrentItem(session);
  if (!current) {
    return finishSession(session);
  }

  const { item } = current;

  switch (action) {
    case "approve": {
      await sql`UPDATE capture_queue SET status = 'approved', processed_at = NOW() WHERE id = ${item.id}`;
      session.approved.push(item.id);
      session.current_index++;
      break;
    }
    case "dismiss": {
      await sql`UPDATE capture_queue SET status = 'dismissed', processed_at = NOW() WHERE id = ${item.id}`;
      session.dismissed.push(item.id);
      session.current_index++;
      break;
    }
    case "skip": {
      session.skipped.push(item.id);
      session.current_index++;
      break;
    }
    case "edit": {
      if (editContent) {
        await sql`UPDATE capture_queue SET refined_content = ${editContent}, status = 'refined' WHERE id = ${item.id}`;
      }
      // Don't advance — show the item again after edit
      return { moved: false, finished: false, message: "Updated. Approve, skip, or dismiss?" };
    }
    case "approve_all": {
      for (let i = session.current_index; i < session.items.length; i++) {
        const id = session.items[i].id;
        await sql`UPDATE capture_queue SET status = 'approved', processed_at = NOW() WHERE id = ${id}`;
        session.approved.push(id);
      }
      session.current_index = session.items.length;
      return finishSession(session);
    }
    case "skip_all": {
      for (let i = session.current_index; i < session.items.length; i++) {
        session.skipped.push(session.items[i].id);
      }
      session.current_index = session.items.length;
      return finishSession(session);
    }
  }

  // Check if we've reached the end
  if (session.current_index >= session.items.length) {
    return finishSession(session);
  }

  return { moved: true, finished: false, message: "" };
}

function finishSession(session: ReviewSession): { moved: boolean; finished: boolean; message: string } {
  session.status = "complete";
  const message = buildSummary(session);
  sessions.delete(session.id);
  return { moved: false, finished: true, message };
}

// Build presentation for current item

export function buildItemPresentation(item: CaptureItem, refinement: RefinementResult, index: number, total: number): string {
  const lines: string[] = [];
  lines.push(`**Item ${index + 1} of ${total}**`);
  lines.push("");
  lines.push(`**Source:** ${item.channel} | **Type:** ${refinement.content_type} | **Confidence:** ${Math.round(refinement.confidence * 100)}%`);
  lines.push("");
  lines.push("**Original:**");
  lines.push(`> ${item.raw_content.substring(0, 200)}${item.raw_content.length > 200 ? "..." : ""}`);
  lines.push("");
  lines.push(`**Title:** ${refinement.title}`);
  lines.push(`**Path:** \`${refinement.suggested_path}\``);
  lines.push("");
  lines.push("Approve, skip, dismiss, or edit?");
  return lines.join("\n");
}

// Build session summary

export function buildSummary(session: ReviewSession): string {
  const total = session.items.length;
  const lines: string[] = [];
  lines.push("**Review Complete**");
  lines.push("");
  lines.push(`- Approved: ${session.approved.length}`);
  lines.push(`- Dismissed: ${session.dismissed.length}`);
  lines.push(`- Skipped: ${session.skipped.length}`);
  lines.push(`- Total reviewed: ${total}`);

  if (session.approved.length > 0) {
    lines.push("");
    lines.push(`${session.approved.length} item${session.approved.length > 1 ? "s" : ""} queued for River write.`);
  }

  return lines.join("\n");
}

// Build the start message

export function buildStartMessage(count: number, channel: Channel): string {
  if (count === 0) return "No items in the capture queue to review.";
  return `Found ${count} item${count > 1 ? "s" : ""} to review. I'll present each one — you can approve, skip, dismiss, or edit. Say "approve all" or "skip all" anytime.\n\nLet's start.`;
}

// For testing
export function _clearSessions(): void {
  sessions.clear();
}
