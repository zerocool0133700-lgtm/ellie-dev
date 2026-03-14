/**
 * ELLIE-718: Checkpoint Notification Delivery
 *
 * Wires checkpoint reports to Telegram/Google Chat/Slack via the notification
 * policy engine, and persists them as work_session_updates.
 *
 * Injectable dependencies for testability — no direct I/O in core logic.
 */

import type { CheckpointReport } from "./checkpoint-types.ts";
import { formatCheckpointMessage, formatCheckpointCompact } from "./checkpoint-report.ts";
import { log } from "./logger.ts";

const logger = log.child("checkpoint-delivery");

// ── Types ────────────────────────────────────────────────────

/** Channel where the work session originated. */
export type SessionChannel = "telegram" | "google-chat" | "slack" | "ellie-chat" | "unknown";

/** Injectable dependencies for checkpoint delivery (testable). */
export interface CheckpointDeliveryDeps {
  /** Send notification via policy engine */
  notify: (options: {
    event: string;
    workItemId: string;
    telegramMessage: string;
    gchatMessage?: string;
  }) => Promise<void>;
  /** Persist checkpoint as work_session_update */
  persistUpdate: (
    workItemId: string,
    message: string,
    details: CheckpointReport,
  ) => Promise<void>;
}

// ── Channel routing (pure) ───────────────────────────────────

/**
 * Determine which notification channels to target based on the originating channel.
 * Returns the channels that should receive the checkpoint notification.
 */
export function resolveDeliveryChannels(
  originChannel: SessionChannel,
): { telegram: boolean; gchat: boolean; slack: boolean } {
  switch (originChannel) {
    case "telegram":
      return { telegram: true, gchat: true, slack: false };
    case "google-chat":
      return { telegram: false, gchat: true, slack: false };
    case "slack":
      return { telegram: false, gchat: false, slack: true };
    case "ellie-chat":
      // Ellie Chat sessions notify on both Telegram + Google Chat
      return { telegram: true, gchat: true, slack: false };
    default:
      // Unknown origin — notify on all available channels
      return { telegram: true, gchat: true, slack: true };
  }
}

// ── Delivery ─────────────────────────────────────────────────

/**
 * Deliver a checkpoint report: notify + persist.
 * Caller provides deps for testability.
 */
export async function deliverCheckpoint(
  deps: CheckpointDeliveryDeps,
  report: CheckpointReport,
  workItemId: string,
  originChannel: SessionChannel,
): Promise<{ notified: boolean; persisted: boolean }> {
  const result = { notified: false, persisted: false };

  // Format messages
  const humanMessage = formatCheckpointMessage(report, workItemId);
  const compactMessage = formatCheckpointCompact(report, workItemId);

  // Notify via policy engine
  try {
    await deps.notify({
      event: "session_checkpoint",
      workItemId,
      telegramMessage: humanMessage,
      gchatMessage: humanMessage,
    });
    result.notified = true;
    logger.info("Checkpoint notification sent", { workItemId, percent: report.percent });
  } catch (err) {
    logger.error("Checkpoint notification failed", {
      workItemId,
      percent: report.percent,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Persist as work_session_update
  try {
    await deps.persistUpdate(workItemId, compactMessage, report);
    result.persisted = true;
  } catch (err) {
    logger.error("Checkpoint persist failed", {
      workItemId,
      percent: report.percent,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}

/**
 * Build the full checkpoint callback that integrates timer → report → delivery.
 * This is the callback passed to startCheckpointTimer().
 */
export function buildCheckpointCallback(
  deps: CheckpointDeliveryDeps,
  originChannel: SessionChannel,
  getSections: (sessionId: string, agent: string) => Promise<Record<string, string | undefined>>,
): (
  sessionId: string,
  workItemId: string,
  agent: string,
  percent: number,
  elapsedMinutes: number,
  estimatedTotalMinutes: number,
) => Promise<void> {
  return async (sessionId, workItemId, agent, percent, elapsedMinutes, estimatedTotalMinutes) => {
    // Dynamically import to avoid circular dependency
    const { generateCheckpointReport } = await import("./checkpoint-report.ts");

    // Get current working memory sections
    let sections: Record<string, string | undefined> = {};
    try {
      sections = await getSections(sessionId, agent);
    } catch (err) {
      logger.error("Failed to read working memory for checkpoint", {
        sessionId, agent,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const report = generateCheckpointReport(sections, percent, elapsedMinutes, estimatedTotalMinutes);

    await deliverCheckpoint(deps, report, workItemId, originChannel);
  };
}

// ── Mock helpers (for testing) ───────────────────────────────

export function _makeMockDeliveryDeps(): {
  deps: CheckpointDeliveryDeps;
  notifications: Array<{ event: string; workItemId: string; message: string }>;
  updates: Array<{ workItemId: string; message: string; details: CheckpointReport }>;
} {
  const notifications: Array<{ event: string; workItemId: string; message: string }> = [];
  const updates: Array<{ workItemId: string; message: string; details: CheckpointReport }> = [];

  return {
    deps: {
      notify: async (opts) => {
        notifications.push({
          event: opts.event,
          workItemId: opts.workItemId,
          message: opts.telegramMessage,
        });
      },
      persistUpdate: async (workItemId, message, details) => {
        updates.push({ workItemId, message, details });
      },
    },
    notifications,
    updates,
  };
}
