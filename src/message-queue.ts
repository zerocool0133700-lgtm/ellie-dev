/**
 * Message Queue — concurrency guard for Claude pipeline.
 *
 * Extracted from relay.ts — ELLIE-206.
 * Two independent queues: main (Telegram + GChat) and ellie-chat.
 *
 * ELLIE-239: Queue-level timeout guard prevents deadlocks if a task
 * hangs beyond the CLI timeout. Tasks are auto-killed after QUEUE_TASK_TIMEOUT_MS.
 */

import type { Context } from "grammy";
import { log } from "./logger.ts";

const logger = log.child("queue");

const QUEUE_TASK_TIMEOUT_MS = parseInt(process.env.QUEUE_TASK_TIMEOUT_MS || "480000"); // 8 min (above CLI 420s + buffer)

// ── External dependency (registered by relay.ts at startup) ──

let _broadcastExtension: (event: Record<string, unknown>) => void = () => {};
export function setQueueBroadcast(fn: typeof _broadcastExtension): void { _broadcastExtension = fn; }

// ── Queue types ──────────────────────────────────────────────

interface QueueItem {
  task: () => Promise<void>;
  channel: string;
  preview: string;
  enqueuedAt: number;
}

// ── Queue-level timeout wrapper (ELLIE-239) ─────────────────

/**
 * Wraps a task with a timeout. If the task doesn't resolve/reject
 * within QUEUE_TASK_TIMEOUT_MS, the wrapper resolves (doesn't throw)
 * so the queue can advance. The underlying task continues running
 * but the queue is no longer blocked.
 */
async function withTimeout(task: () => Promise<void>, channel: string, preview: string): Promise<void> {
  let resolved = false;

  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(() => {
      if (!resolved) {
        logger.error("Queue task timeout — unblocking queue", {
          channel,
          preview,
          timeoutMs: QUEUE_TASK_TIMEOUT_MS,
        });
        _broadcastExtension({
          type: "error",
          source: "queue",
          message: `Task timed out after ${QUEUE_TASK_TIMEOUT_MS / 1000}s on ${channel}`,
        });
        resolve();
      }
    }, QUEUE_TASK_TIMEOUT_MS);
  });

  try {
    await Promise.race([task(), timeoutPromise]);
  } catch (err) {
    logger.error("Queue task error", { channel, preview }, err);
  } finally {
    resolved = true;
  }
}

// ── Main queue (Telegram + Google Chat) ──────────────────────

let busy = false;
let currentItem: { channel: string; preview: string; startedAt: number } | null = null;
const messageQueue: QueueItem[] = [];

async function processQueue(): Promise<void> {
  while (messageQueue.length > 0) {
    const next = messageQueue.shift()!;
    const waitMs = Date.now() - next.enqueuedAt;
    if (waitMs > 60_000) {
      logger.warn("Queue item waited too long", { channel: next.channel, preview: next.preview, waitMs });
    }
    currentItem = { channel: next.channel, preview: next.preview, startedAt: Date.now() };
    _broadcastExtension({ type: "queue_status", busy: true, queueLength: messageQueue.length, current: currentItem });
    await withTimeout(next.task, next.channel, next.preview);
  }
  currentItem = null;
  busy = false;
  _broadcastExtension({ type: "queue_status", busy: false, queueLength: 0, current: null });
}

/**
 * Enqueue a task for the shared Claude pipeline.
 * Used by non-Telegram channels (Google Chat) that don't have a grammY ctx.
 * Returns a promise that resolves when the task completes.
 */
export function enqueue(
  task: () => Promise<void>,
  channel: string = "google-chat",
  preview: string = "(message)",
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const item: QueueItem = {
      task: async () => {
        try {
          await task();
          resolve();
        } catch (err) {
          reject(err);
        }
      },
      channel,
      preview,
      enqueuedAt: Date.now(),
    };

    if (busy) {
      messageQueue.push(item);
      return;
    }
    busy = true;
    currentItem = { channel: item.channel, preview: item.preview, startedAt: Date.now() };
    item.task().finally(() => processQueue());
  });
}

// ── Ellie Chat independent queue ─────────────────────────────

let ellieChatQueueBusy = false;
let ellieChatCurrentItem: { channel: string; preview: string; startedAt: number } | null = null;
const ellieChatMessageQueue: QueueItem[] = [];

async function processEllieChatQueue(): Promise<void> {
  while (ellieChatMessageQueue.length > 0) {
    const next = ellieChatMessageQueue.shift()!;
    const waitMs = Date.now() - next.enqueuedAt;
    if (waitMs > 60_000) {
      logger.warn("Queue item waited too long", { channel: next.channel, preview: next.preview, waitMs });
    }
    ellieChatCurrentItem = { channel: next.channel, preview: next.preview, startedAt: Date.now() };
    _broadcastExtension({ type: "queue_status", busy: busy || ellieChatQueueBusy, queueLength: messageQueue.length + ellieChatMessageQueue.length, current: ellieChatCurrentItem });
    await withTimeout(next.task, next.channel, next.preview);
  }
  ellieChatCurrentItem = null;
  ellieChatQueueBusy = false;
  _broadcastExtension({ type: "queue_status", busy, queueLength: messageQueue.length, current: currentItem });
}

export function enqueueEllieChat(
  task: () => Promise<void>,
  preview: string = "(message)",
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const item: QueueItem = {
      task: async () => {
        try {
          await task();
          resolve();
        } catch (err) {
          reject(err);
        }
      },
      channel: "ellie-chat",
      preview,
      enqueuedAt: Date.now(),
    };

    if (ellieChatQueueBusy) {
      ellieChatMessageQueue.push(item);
      return;
    }
    ellieChatQueueBusy = true;
    ellieChatCurrentItem = { channel: item.channel, preview: item.preview, startedAt: Date.now() };
    item.task().finally(() => processEllieChatQueue());
  });
}

// ── Telegram queue wrapper ───────────────────────────────────

export function withQueue(
  handler: (ctx: Context) => Promise<void>,
  previewExtractor?: (ctx: Context) => string,
) {
  return async (ctx: Context) => {
    const preview = previewExtractor
      ? previewExtractor(ctx)
      : (ctx.message?.text?.substring(0, 50) ?? "(no text)");

    if (busy) {
      const position = messageQueue.length + 1;
      await ctx.reply(`I'm working on something — I'll get to this next. (Queue position: ${position})`);
      messageQueue.push({
        task: () => handler(ctx),
        channel: "telegram",
        preview,
        enqueuedAt: Date.now(),
      });
      return;
    }
    busy = true;
    currentItem = { channel: "telegram", preview, startedAt: Date.now() };
    try {
      await withTimeout(() => handler(ctx), "telegram", preview);
    } finally {
      await processQueue();
    }
  };
}

// ── Queue status (for HTTP endpoint) ─────────────────────────

export function getQueueStatus() {
  const active = currentItem || ellieChatCurrentItem;
  return {
    busy: busy || ellieChatQueueBusy,
    queueLength: messageQueue.length + ellieChatMessageQueue.length,
    current: active
      ? {
          channel: active.channel,
          preview: active.preview,
          durationMs: Date.now() - active.startedAt,
        }
      : null,
    queued: [...messageQueue, ...ellieChatMessageQueue].map((item, index) => ({
      position: index + 1,
      channel: item.channel,
      preview: item.preview,
      waitingMs: Date.now() - item.enqueuedAt,
    })),
  };
}
