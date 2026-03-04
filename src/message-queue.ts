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
import { appendFile, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { log } from "./logger.ts";

const logger = log.child("queue");

// ── DLQ persistence (ELLIE-490) ──────────────────────────────

const RELAY_DIR = process.env.RELAY_DIR ?? join(process.env.HOME ?? "~", ".claude-relay");
const DLQ_PATH = join(RELAY_DIR, "dlq.jsonl");

const QUEUE_TASK_TIMEOUT_MS = parseInt(process.env.QUEUE_TASK_TIMEOUT_MS || "720000"); // 12 min (above CLI 600s + buffer)

// ── External dependency (registered by relay.ts at startup) ──

let _broadcastExtension: (event: Record<string, unknown>) => void = () => {};
export function setQueueBroadcast(fn: typeof _broadcastExtension): void { _broadcastExtension = fn; }

// ── Queue types ──────────────────────────────────────────────

/**
 * ELLIE-482: Tasks accept an AbortSignal so the queue can cancel them on timeout.
 * Existing callers may use `() => Promise<void>` — TypeScript allows fewer params.
 */
export type QueueTask = (signal: AbortSignal) => Promise<void>;

interface QueueItem {
  task: QueueTask;
  channel: string;
  preview: string;
  enqueuedAt: number;
}

export interface DeadLetterEntry {
  id: string;       // ELLIE-490: stable ID for selective deletion
  channel: string;
  preview: string;
  error: string;
  ts: number;
  queue: string;    // "main" | "ellie-chat" — set on persist
}

// ── Queue-level timeout wrapper (ELLIE-239) ─────────────────

/**
 * Wraps a task with a timeout. Returns false if timed out or errored.
 * The queue is unblocked either way so processing can continue.
 * Exported with _ prefix for unit testing (ELLIE-465).
 *
 * ELLIE-482: Creates an AbortController per task. On timeout, aborts the
 * controller (which kills any spawned subprocess via callClaude's abortSignal
 * handler) before unblocking the queue. The signal is passed to the task so
 * it can propagate it to callClaude().
 *
 * @param _testTimeoutMs Override timeout for unit tests only.
 */
export async function _withQueueTimeout(task: QueueTask, channel: string, preview: string, _testTimeoutMs?: number): Promise<boolean> {
  return withTimeout(task, channel, preview, _testTimeoutMs);
}
async function withTimeout(task: QueueTask, channel: string, preview: string, overrideMs?: number): Promise<boolean> {
  let resolved = false;
  let success = true;
  const controller = new AbortController();
  const timeoutMs = overrideMs ?? QUEUE_TASK_TIMEOUT_MS;

  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(() => {
      if (!resolved) {
        success = false;
        controller.abort();  // ELLIE-482: kill spawned subprocess
        logger.error("Queue task timeout — aborting task and unblocking queue", {
          channel,
          preview,
          timeoutMs,
        });
        _broadcastExtension({
          type: "error",
          source: "queue",
          message: `Task timed out after ${timeoutMs / 1000}s on ${channel}`,
        });
        resolve();
      }
    }, timeoutMs);
  });

  // Keep a reference so we can suppress its unhandled rejection after timeout
  const taskPromise = task(controller.signal);
  try {
    await Promise.race([taskPromise, timeoutPromise]);
  } catch (err) {
    success = false;
    logger.error("Queue task error", { channel, preview }, err);
  } finally {
    resolved = true;
    // Prevent unhandled rejection if the task throws after the timeout race settled
    taskPromise.catch(() => {});
  }

  return success;
}

// ── ChannelQueue class (ELLIE-459) ───────────────────────────

const MAX_DEAD_LETTERS = 100;

/** Exported for unit testing (ELLIE-465). */
export class ChannelQueue {
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

  // ELLIE-490: restore a persisted entry without re-persisting it
  restoreDeadLetter(entry: DeadLetterEntry): void {
    this._deadLetters.push(entry);
  }

  clearDeadLetterById(id: string): boolean {
    const before = this._deadLetters.length;
    this._deadLetters = this._deadLetters.filter(e => e.id !== id);
    return this._deadLetters.length < before;
  }

  clearAllDeadLetters(): void {
    this._deadLetters = [];
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

  // ELLIE-482: Unified task runner — all tasks go through withTimeout for consistent
  // abort-on-timeout behaviour (including the first task, which previously bypassed it).
  private async _runTask(item: QueueItem): Promise<void> {
    const ok = await withTimeout(item.task, item.channel, item.preview);
    if (!ok) {
      const entry: DeadLetterEntry = {
        id: randomUUID(),
        channel: item.channel,
        preview: item.preview,
        error: "timed out or failed",
        ts: Date.now(),
        queue: this.name,
      };
      this._deadLetters.push(entry);
      if (this._deadLetters.length > MAX_DEAD_LETTERS) {
        this._deadLetters.shift();
        rewriteDlqFile().catch(() => {});
      } else {
        persistDeadLetter(entry).catch(() => {});
      }
      logger.error("Task added to dead letter queue", { queue: this.name, channel: entry.channel, preview: entry.preview });
    }
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
      await this._runTask(next);
    }
    this._current = null;
    this._busy = false;
    this.broadcast();
  }

  enqueue(task: QueueTask, channel: string, preview: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const item: QueueItem = {
        task: async (signal: AbortSignal) => {
          try {
            await task(signal);
            resolve();
          } catch (err) {
            reject(err);
            throw err; // re-throw so _runTask/withTimeout records the failure
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
      this.broadcast();
      // ELLIE-482: Route first task through _runTask too (consistent abort behaviour)
      this._runTask(item).finally(() => this.process());
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
  task: QueueTask,
  channel: string = "google-chat",
  preview: string = "(message)",
): Promise<void> {
  return mainQueue.enqueue(task, channel, preview);
}

// ── Public API: Ellie Chat queue ─────────────────────────────

export function enqueueEllieChat(
  task: QueueTask,
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
      // ELLIE-482: signal forwarded but Telegram handlers don't use it yet
      mainQueue.enqueue((_signal) => handler(ctx), "telegram", preview).catch((err) => {
        logger.error("Queued Telegram task failed", { preview }, err);
      });
      return;
    }
    return mainQueue.enqueue((_signal) => handler(ctx), "telegram", preview);
  };
}

// ── Graceful drain (ELLIE-460) ────────────────────────────────

/**
 * Wait for both queues to become idle, up to timeoutMs.
 * Used by gracefulShutdown to avoid zombie tasks on relay restart.
 * Resolves true if drained cleanly, false if timed out.
 */
export async function drainQueues(timeoutMs: number = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (mainQueue.isBusy || ellieChatQueue.isBusy) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>(r => setTimeout(r, 500));
  }
  return true;
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
    deadLetters: [...mainQueue.getDeadLetters(), ...ellieChatQueue.getDeadLetters()]
      .sort((a, b) => a.ts - b.ts)
      .slice(-20),
  };
}

// ── DLQ persistence helpers (ELLIE-490) ──────────────────────

function allDeadLetters(): DeadLetterEntry[] {
  return [...mainQueue.getDeadLetters(), ...ellieChatQueue.getDeadLetters()]
    .sort((a, b) => a.ts - b.ts);
}

async function persistDeadLetter(entry: DeadLetterEntry): Promise<void> {
  await mkdir(RELAY_DIR, { recursive: true });
  await appendFile(DLQ_PATH, JSON.stringify(entry) + "\n", "utf-8");
}

async function rewriteDlqFile(): Promise<void> {
  const entries = allDeadLetters();
  await mkdir(RELAY_DIR, { recursive: true });
  await writeFile(DLQ_PATH, entries.map(e => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""), "utf-8");
}

/** Load persisted dead letters from disk into memory. Called once at startup. */
export async function loadPersistedDeadLetters(): Promise<void> {
  try {
    const raw = await readFile(DLQ_PATH, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const parsed: DeadLetterEntry[] = [];
    for (const line of lines) {
      try { parsed.push(JSON.parse(line) as DeadLetterEntry); } catch {}
    }
    // Cap to last MAX_DEAD_LETTERS total
    const trimmed = parsed.slice(-MAX_DEAD_LETTERS);
    for (const entry of trimmed) {
      if (entry.queue === "main") mainQueue.restoreDeadLetter(entry);
      else ellieChatQueue.restoreDeadLetter(entry);
    }
    if (trimmed.length > 0) logger.info(`[DLQ] Restored ${trimmed.length} dead letters from disk`);
    // Rewrite if we trimmed anything
    if (parsed.length > trimmed.length) await rewriteDlqFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn("[DLQ] Failed to load persisted dead letters", { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** List all dead letters across both queues. */
export function listDeadLetters(): DeadLetterEntry[] {
  return allDeadLetters();
}

/** Clear all dead letters and wipe the DLQ file. */
export async function clearAllDeadLetters(): Promise<void> {
  mainQueue.clearAllDeadLetters();
  ellieChatQueue.clearAllDeadLetters();
  await mkdir(RELAY_DIR, { recursive: true });
  await writeFile(DLQ_PATH, "", "utf-8");
}

/** Clear a single dead letter by id. Returns false if not found. */
export async function clearDeadLetterById(id: string): Promise<boolean> {
  const found = mainQueue.clearDeadLetterById(id) || ellieChatQueue.clearDeadLetterById(id);
  if (found) await rewriteDlqFile();
  return found;
}
