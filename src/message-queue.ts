/**
 * Message Queue — concurrency guard for Claude pipeline.
 *
 * Extracted from relay.ts — ELLIE-206.
 * Two independent queues: main (Telegram + GChat) and ellie-chat.
 *
 * ELLIE-239: Queue-level timeout guard prevents deadlocks if a task
 * hangs beyond the CLI timeout. Tasks are auto-killed after QUEUE_TASK_TIMEOUT_MS.
 *
 * ELLIE-459: Refactored into ChannelQueue class to eliminate dual-busy-flag
 * race conditions. Dead letter queue tracks failed/timed-out tasks instead
 * of silently dropping them.
 */

import type { Context } from "grammy";
import { log } from "./logger.ts";

const logger = log.child("queue");

const QUEUE_TASK_TIMEOUT_MS = parseInt(process.env.QUEUE_TASK_TIMEOUT_MS || "720000"); // 12 min (above CLI 600s + buffer)

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

export interface DeadLetterEntry {
  channel: string;
  preview: string;
  error: string;
  ts: number;
}

// ── Queue-level timeout wrapper (ELLIE-239) ─────────────────

/**
 * Wraps a task with a timeout. Returns false if timed out or errored.
 * The queue is unblocked either way so processing can continue.
 */
async function withTimeout(task: () => Promise<void>, channel: string, preview: string): Promise<boolean> {
  let resolved = false;
  let success = true;

  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(() => {
      if (!resolved) {
        success = false;
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
    success = false;
    logger.error("Queue task error", { channel, preview }, err);
  } finally {
    resolved = true;
  }

  return success;
}

// ── ChannelQueue class (ELLIE-459) ───────────────────────────

const MAX_DEAD_LETTERS = 100;

class ChannelQueue {
  private _busy = false;
  private _current: { channel: string; preview: string; startedAt: number } | null = null;
  private _queue: QueueItem[] = [];
  private _deadLetters: DeadLetterEntry[] = [];

  constructor(private readonly name: string) {}

  get isBusy(): boolean { return this._busy; }
  get length(): number { return this._queue.length; }
  get current() { return this._current; }

  getDeadLetters(): DeadLetterEntry[] {
    return [...this._deadLetters];
  }

  private broadcast(): void {
    _broadcastExtension({
      type: "queue_status",
      queue: this.name,
      busy: this._busy,
      queueLength: this._queue.length,
      current: this._current,
    });
  }

  private async process(): Promise<void> {
    while (this._queue.length > 0) {
      const next = this._queue.shift()!;
      const waitMs = Date.now() - next.enqueuedAt;
      if (waitMs > 60_000) {
        logger.warn("Queue item waited too long", { queue: this.name, channel: next.channel, preview: next.preview, waitMs });
      }
      this._current = { channel: next.channel, preview: next.preview, startedAt: Date.now() };
      this.broadcast();
      const ok = await withTimeout(next.task, next.channel, next.preview);
      if (!ok) {
        const entry: DeadLetterEntry = {
          channel: next.channel,
          preview: next.preview,
          error: "timed out or failed",
          ts: Date.now(),
        };
        this._deadLetters.push(entry);
        if (this._deadLetters.length > MAX_DEAD_LETTERS) this._deadLetters.shift();
        logger.error("Task added to dead letter queue", { queue: this.name, channel: entry.channel, preview: entry.preview });
      }
    }
    this._current = null;
    this._busy = false;
    this.broadcast();
  }

  enqueue(task: () => Promise<void>, channel: string, preview: string): Promise<void> {
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

      if (this._busy) {
        this._queue.push(item);
        return;
      }
      this._busy = true;
      this._current = { channel, preview, startedAt: Date.now() };
      item.task().finally(() => this.process());
    });
  }

  getStatus() {
    return {
      busy: this._busy,
      queueLength: this._queue.length,
      current: this._current
        ? {
            channel: this._current.channel,
            preview: this._current.preview,
            durationMs: Date.now() - this._current.startedAt,
          }
        : null,
      queued: this._queue.map((item, index) => ({
        position: index + 1,
        channel: item.channel,
        preview: item.preview,
        waitingMs: Date.now() - item.enqueuedAt,
      })),
    };
  }
}

// ── Queue instances ──────────────────────────────────────────

const mainQueue = new ChannelQueue("main");           // Telegram + GChat
const ellieChatQueue = new ChannelQueue("ellie-chat"); // Ellie Chat

// ── Public API: Main queue (Telegram + Google Chat) ──────────

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
  return mainQueue.enqueue(task, channel, preview);
}

// ── Public API: Ellie Chat queue ─────────────────────────────

export function enqueueEllieChat(
  task: () => Promise<void>,
  preview: string = "(message)",
): Promise<void> {
  return ellieChatQueue.enqueue(task, "ellie-chat", preview);
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

    if (mainQueue.isBusy) {
      const position = mainQueue.length + 1;
      await ctx.reply(`I'm working on something — I'll get to this next. (Queue position: ${position})`);
      // Fire-and-forget when queuing — returns immediately after the reply (original behavior)
      mainQueue.enqueue(() => handler(ctx), "telegram", preview).catch((err) => {
        logger.error("Queued Telegram task failed", { preview }, err);
      });
      return;
    }
    return mainQueue.enqueue(() => handler(ctx), "telegram", preview);
  };
}

// ── Queue status (for HTTP endpoint) ─────────────────────────

export function getQueueStatus() {
  const mainStatus = mainQueue.getStatus();
  const ellieChatStatus = ellieChatQueue.getStatus();
  const active = mainStatus.current || ellieChatStatus.current;
  return {
    busy: mainStatus.busy || ellieChatStatus.busy,
    queueLength: mainStatus.queueLength + ellieChatStatus.queueLength,
    current: active,
    queued: [...mainStatus.queued, ...ellieChatStatus.queued],
    deadLetters: [...mainQueue.getDeadLetters(), ...ellieChatQueue.getDeadLetters()].slice(-20),
  };
}
