/**
 * Trace Context — ELLIE-398
 *
 * Generates and propagates trace IDs through the async call chain
 * using Node's AsyncLocalStorage. Any code running within a
 * `withTrace()` callback automatically has access to the current
 * trace ID — the logger picks it up without explicit threading.
 *
 * Usage:
 *   import { withTrace, getTraceId } from "./trace.ts";
 *
 *   // At ingestion point:
 *   await withTrace(async () => {
 *     // All logs within this scope include trace_id automatically
 *     logger.info("Processing message");
 *   });
 *
 *   // Manual access:
 *   const traceId = getTraceId(); // returns current trace ID or null
 */

import { AsyncLocalStorage } from "node:async_hooks";

// ── Async context store ──────────────────────────────────────

interface TraceContext {
  traceId: string;
}

const traceStore = new AsyncLocalStorage<TraceContext>();

// ── Public API ───────────────────────────────────────────────

/** Generate a short trace ID (16 hex chars — compact but unique enough). */
export function generateTraceId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

/** Get the current trace ID from async context (null if none active). */
export function getTraceId(): string | null {
  return traceStore.getStore()?.traceId ?? null;
}

/**
 * Run a function within a trace context.
 * All async operations within the callback inherit the trace ID.
 * If a trace is already active, creates a nested context with a new ID.
 */
export function withTrace<T>(fn: () => T, traceId?: string): T {
  const id = traceId ?? generateTraceId();
  return traceStore.run({ traceId: id }, fn);
}

/**
 * Run an async function within a trace context.
 * Convenience wrapper for async entry points.
 */
export async function withTraceAsync<T>(fn: () => Promise<T>, traceId?: string): Promise<T> {
  const id = traceId ?? generateTraceId();
  return traceStore.run({ traceId: id }, fn);
}
