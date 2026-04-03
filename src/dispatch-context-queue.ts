/**
 * Dispatch Context Queue — ELLIE-1317
 *
 * Queues Dave's messages for running agents via working memory.
 * When a dispatch completes, the coordinator checks for queued context
 * and auto-redispatches the agent with it.
 *
 * Uses working memory context_anchors section — persists in Forest DB,
 * survives relay restarts.
 */

import { log } from "./logger.ts";
import { updateWorkingMemory, readWorkingMemory } from "./working-memory.ts";

const logger = log.child("dispatch-context-queue");

export const QUEUED_CONTEXT_MARKER = "[QUEUED from Dave]";

/**
 * Queue a message from Dave for a running agent.
 * Writes to the agent's working memory context_anchors section.
 */
export async function queueContextForAgent(
  sessionId: string,
  agent: string,
  message: string,
): Promise<void> {
  const timestamp = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  const markerLine = `${QUEUED_CONTEXT_MARKER} @ ${timestamp}: ${message}`;

  try {
    await updateWorkingMemory({
      session_id: sessionId,
      agent,
      sections: {
        context_anchors: markerLine,
      },
    });
    logger.info("Context queued for agent", { agent, messagePreview: message.slice(0, 100) });

    // Broadcast routing feedback to UI
    try {
      const { broadcastDispatchEvent } = await import("./relay-state.ts");
      broadcastDispatchEvent({
        type: "routing_feedback",
        agent,
        message: `Queued for ${agent}`,
        ts: Date.now(),
      });
    } catch { /* best-effort */ }
  } catch (err) {
    logger.error("Failed to queue context", { agent, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Check if an agent has queued context from Dave.
 * Returns the queued messages (without markers), or empty array.
 */
export async function checkQueuedContext(
  sessionId: string,
  agent: string,
): Promise<string[]> {
  try {
    const record = await readWorkingMemory({ session_id: sessionId, agent });
    if (!record) return [];

    const anchors = record.sections?.context_anchors;
    if (!anchors || typeof anchors !== "string") return [];

    return anchors
      .split("\n")
      .filter(line => line.includes(QUEUED_CONTEXT_MARKER))
      .map(line => line.replace(/\[QUEUED from Dave\] @ \d{2}:\d{2}: /, "").trim())
      .filter(msg => msg.length > 0);
  } catch (err) {
    logger.error("Failed to check queued context", { agent, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/**
 * Clear queued context markers from an agent's working memory.
 * Called after auto-redispatch.
 */
export async function clearQueuedContext(
  sessionId: string,
  agent: string,
): Promise<void> {
  try {
    const record = await readWorkingMemory({ session_id: sessionId, agent });
    if (!record) return;

    const anchors = record.sections?.context_anchors;
    if (!anchors || typeof anchors !== "string") return;

    const cleaned = anchors
      .split("\n")
      .filter(line => !line.includes(QUEUED_CONTEXT_MARKER))
      .join("\n")
      .trim();

    await updateWorkingMemory({
      session_id: sessionId,
      agent,
      sections: { context_anchors: cleaned },
    });
    logger.info("Queued context cleared", { agent });
  } catch (err) {
    logger.error("Failed to clear queued context", { agent, error: err instanceof Error ? err.message : String(err) });
  }
}
