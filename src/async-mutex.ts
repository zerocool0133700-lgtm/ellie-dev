/**
 * AsyncMutex — ELLIE-574, extracted ELLIE-579
 *
 * Lightweight async mutex for serializing read-modify-write operations.
 * Used by dashboard, ticket-context-card, dispatch-journal, and post-mortem
 * writers to prevent concurrent file corruption.
 */

/** Default lock acquisition timeout in ms. */
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

/**
 * Lightweight async mutex for serializing read-modify-write operations.
 * Supports timeout to avoid deadlocks.
 */
export class AsyncMutex {
  private _queue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private _locked = false;

  get locked(): boolean {
    return this._locked;
  }

  get queueLength(): number {
    return this._queue.length;
  }

  /**
   * Acquire the lock, execute fn, then release.
   * Throws if lock isn't acquired within timeoutMs.
   */
  async withLock<T>(fn: () => Promise<T>, timeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS): Promise<T> {
    await this._acquire(timeoutMs);
    try {
      return await fn();
    } finally {
      this._release();
    }
  }

  private _acquire(timeoutMs: number): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const entry = { resolve, reject };
      this._queue.push(entry);

      const timer = setTimeout(() => {
        const idx = this._queue.indexOf(entry);
        if (idx !== -1) {
          this._queue.splice(idx, 1);
          reject(new Error(`Lock acquisition timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      // Prevent timer from keeping Node alive
      if (timer.unref) timer.unref();

      const origResolve = entry.resolve;
      entry.resolve = () => {
        clearTimeout(timer);
        origResolve();
      };
    });
  }

  private _release(): void {
    const next = this._queue.shift();
    if (next) {
      next.resolve();
    } else {
      this._locked = false;
    }
  }
}
