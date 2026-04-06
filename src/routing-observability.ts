/**
 * Routing Observability — ELLIE-1452
 *
 * Captures Max's routing decisions (which agent, why) and provides:
 *   1. WebSocket events for Ellie Chat UI (expandable routing detail)
 *   2. Dispatch journal entries with routing reasoning
 *   3. "Wrong agent" feedback capture for tuning
 *
 * Fire-and-forget — failures never block the coordinator loop.
 */

import { log } from "./logger.ts";
import { broadcastDispatchEvent } from "./relay-state.ts";
import { appendJournalEntry } from "./dispatch-journal.ts";

const logger = log.child("routing-observability");

// ── Types ────────────────────────────────────────────────────────────────────

export interface RoutingDecisionEvent {
  /** Dispatch envelope ID */
  envelopeId: string;
  /** Agent that was chosen */
  agentChosen: string;
  /** Task description sent to the agent */
  task: string;
  /** Max's reasoning (extracted from text blocks before the tool call) */
  reasoning: string;
  /** Other agents that were available */
  agentsAvailable: string[];
  /** Work item if applicable */
  workItemId?: string | null;
  /** Thread context */
  threadId?: string | null;
  /** Timestamp */
  timestamp: number;
}

export interface RoutingFeedback {
  /** The envelope ID of the dispatch being corrected */
  envelopeId: string;
  /** The agent that was originally chosen */
  originalAgent: string;
  /** The agent the user thinks should have been chosen (optional) */
  suggestedAgent?: string;
  /** User's comment about the mismatch */
  comment?: string;
  /** Timestamp */
  timestamp: number;
}

// ── In-memory routing decision log ───────────────────────────────────────────
// Keep recent decisions for feedback correlation

const RECENT_DECISIONS_MAX = 50;
const _recentDecisions: RoutingDecisionEvent[] = [];

export function getRecentRoutingDecisions(): readonly RoutingDecisionEvent[] {
  return _recentDecisions;
}

/** Exposed for testing */
export function _clearDecisionsForTesting(): void {
  _recentDecisions.length = 0;
}

// ── In-memory feedback log ───────────────────────────────────────────────────

const RECENT_FEEDBACK_MAX = 100;
const _feedbackLog: RoutingFeedback[] = [];

export function getRoutingFeedback(): readonly RoutingFeedback[] {
  return _feedbackLog;
}

/** Exposed for testing */
export function _clearFeedbackForTesting(): void {
  _feedbackLog.length = 0;
}

// ── Extract reasoning from coordinator response ──────────────────────────────

/**
 * Extract Max's reasoning text from the content blocks that precede a
 * dispatch_agent tool call. The coordinator often includes thinking text
 * before calling tools.
 */
export function extractRoutingReasoning(
  contentBlocks: Array<Record<string, unknown>>,
  dispatchToolUseId: string,
): string {
  const textParts: string[] = [];
  for (const block of contentBlocks) {
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    }
    // Stop when we hit the specific dispatch tool call
    if (block.type === "tool_use" && block.id === dispatchToolUseId) {
      break;
    }
  }
  // Return the last text block before the tool call (most relevant)
  const combined = textParts.join(" ").trim();
  // Cap at 500 chars for storage
  return combined.length > 500 ? combined.slice(0, 500) + "..." : combined;
}

// ── Emit routing decision ────────────────────────────────────────────────────

/**
 * Record and broadcast a routing decision. Called after each dispatch_agent
 * tool call is processed in the coordinator loop.
 *
 * Fire-and-forget — never throws.
 */
export function emitRoutingDecision(decision: RoutingDecisionEvent): void {
  try {
    // Store in memory
    _recentDecisions.push(decision);
    if (_recentDecisions.length > RECENT_DECISIONS_MAX) {
      _recentDecisions.shift();
    }

    // Broadcast to Ellie Chat via WebSocket
    broadcastDispatchEvent({
      type: "routing_decision",
      envelope_id: decision.envelopeId,
      agent_chosen: decision.agentChosen,
      task: decision.task.slice(0, 200),
      reasoning: decision.reasoning.slice(0, 300),
      agents_available: decision.agentsAvailable,
      work_item_id: decision.workItemId ?? null,
      thread_id: decision.threadId ?? null,
      timestamp: decision.timestamp,
    });

    logger.info({
      agent: decision.agentChosen,
      task: decision.task.slice(0, 100),
      hasReasoning: decision.reasoning.length > 0,
    }, "Routing decision emitted");
  } catch (err) {
    logger.warn("Failed to emit routing decision", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Journal routing decisions ────────────────────────────────────────────────

/**
 * Append a routing decision entry to the daily dispatch journal.
 * Fire-and-forget — returns immediately.
 */
export function journalRoutingDecision(decision: RoutingDecisionEvent): void {
  const ts = new Date(decision.timestamp).toISOString();
  const reasoning = decision.reasoning
    ? `\n- **Reasoning:** ${decision.reasoning.slice(0, 300)}`
    : "";

  const entry = [
    "",
    `### Routing Decision — ${decision.agentChosen}`,
    "",
    `- **Time:** ${ts}`,
    `- **Agent:** ${decision.agentChosen}`,
    `- **Task:** ${decision.task.slice(0, 200)}`,
    `- **Available:** ${decision.agentsAvailable.join(", ")}`,
    decision.workItemId ? `- **Work Item:** ${decision.workItemId}` : null,
    reasoning,
    "",
  ].filter(Boolean).join("\n");

  // Fire-and-forget
  appendJournalEntry(entry).catch(() => {});
}

// ── Process routing feedback ─────────────────────────────────────────────────

/**
 * Record user feedback that a routing decision was wrong.
 * Called when Dave sends a "wrong agent" signal via Ellie Chat.
 */
export function recordRoutingFeedback(feedback: RoutingFeedback): void {
  try {
    _feedbackLog.push(feedback);
    if (_feedbackLog.length > RECENT_FEEDBACK_MAX) {
      _feedbackLog.shift();
    }

    logger.info({
      originalAgent: feedback.originalAgent,
      suggestedAgent: feedback.suggestedAgent,
      envelopeId: feedback.envelopeId,
    }, "Routing feedback recorded");

    // Journal the feedback
    const ts = new Date(feedback.timestamp).toISOString();
    const entry = [
      "",
      `### Routing Feedback — Wrong Agent`,
      "",
      `- **Time:** ${ts}`,
      `- **Original Agent:** ${feedback.originalAgent}`,
      feedback.suggestedAgent ? `- **Suggested Agent:** ${feedback.suggestedAgent}` : null,
      feedback.comment ? `- **Comment:** ${feedback.comment}` : null,
      `- **Envelope:** \`${feedback.envelopeId}\``,
      "",
    ].filter(Boolean).join("\n");

    appendJournalEntry(entry).catch(() => {});

    // Write to Forest for long-term learning
    writeRoutingFeedbackToForest(feedback).catch(() => {});
  } catch (err) {
    logger.warn("Failed to record routing feedback", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Forest write-back for routing feedback ───────────────────────────────────

const BRIDGE_KEY = "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a";

async function writeRoutingFeedbackToForest(feedback: RoutingFeedback): Promise<void> {
  const content = [
    `Routing mismatch: dispatched to ${feedback.originalAgent}`,
    feedback.suggestedAgent ? `, should have been ${feedback.suggestedAgent}` : "",
    feedback.comment ? `. User feedback: ${feedback.comment}` : "",
  ].join("");

  try {
    await fetch("http://localhost:3001/api/bridge/write", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-key": BRIDGE_KEY,
      },
      body: JSON.stringify({
        content,
        type: "finding",
        scope_path: "2/1",
        confidence: 0.9,
        metadata: { envelope_id: feedback.envelopeId },
      }),
    });
  } catch {
    // Best-effort
  }
}

// ── API handler for routing feedback ─────────────────────────────────────────

/**
 * HTTP handler for POST /api/routing/feedback.
 * Called from Ellie Chat when Dave flags a wrong agent.
 */
export async function handleRoutingFeedback(
  req: { json: () => Promise<Record<string, unknown>> },
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const body = await req.json();
    const { envelope_id, original_agent, suggested_agent, comment } = body;

    if (!envelope_id || !original_agent) {
      return { status: 400, body: { error: "envelope_id and original_agent are required" } };
    }

    recordRoutingFeedback({
      envelopeId: envelope_id as string,
      originalAgent: original_agent as string,
      suggestedAgent: suggested_agent as string | undefined,
      comment: comment as string | undefined,
      timestamp: Date.now(),
    });

    return { status: 200, body: { ok: true } };
  } catch (err) {
    return { status: 500, body: { error: "Internal server error" } };
  }
}

/**
 * HTTP handler for GET /api/routing/decisions.
 * Returns recent routing decisions for dashboard/debugging.
 */
export function handleGetRoutingDecisions(): { status: number; body: Record<string, unknown> } {
  return {
    status: 200,
    body: {
      decisions: _recentDecisions.slice(-20).reverse(),
      count: _recentDecisions.length,
    },
  };
}

/**
 * HTTP handler for GET /api/routing/feedback.
 * Returns recent routing feedback for review.
 */
export function handleGetRoutingFeedback(): { status: number; body: Record<string, unknown> } {
  return {
    status: 200,
    body: {
      feedback: _feedbackLog.slice(-20).reverse(),
      count: _feedbackLog.length,
    },
  };
}
