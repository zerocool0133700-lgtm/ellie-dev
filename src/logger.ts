/**
 * Structured Logger — ELLIE-226
 *
 * Drop-in replacement for console.log/warn/error with:
 * - Structured JSON output (level, timestamp, module, message, context)
 * - Correlation IDs (conversation_id, session_id, work_item_id)
 * - Error/warn indexing to Elasticsearch (ellie-logs index)
 * - Module-scoped child loggers via logger.child("module-name")
 *
 * Usage:
 *   import { log } from "./logger.ts";
 *   const logger = log.child("orchestrator");
 *   logger.info("Pipeline started", { steps: 5 });
 *   logger.error("Step failed", { step: 2, error: err });
 *
 * Or use the global logger directly:
 *   import { log } from "./logger.ts";
 *   log.error("Something broke", { module: "relay" });
 */

import { getTraceId } from "./trace.ts";

const ES_URL = process.env.ELASTICSEARCH_URL || "";
const LOG_LEVEL = (process.env.LOG_LEVEL || "info") as LogLevel;
const ES_LOG_ENABLED = process.env.ES_LOG_ENABLED !== "false";

// ── Types ────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  context?: Record<string, unknown>;
  trace_id?: string;
  conversation_id?: string;
  session_id?: string;
  work_item_id?: string;
  error?: {
    message: string;
    stack?: string;
    name?: string;
  };
}

interface LogContext {
  trace_id?: string;
  conversation_id?: string;
  session_id?: string;
  work_item_id?: string;
  [key: string]: unknown;
}

// ── Level ordering ───────────────────────────────────────────

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[LOG_LEVEL];
}

// ── ES indexing (fire-and-forget) ────────────────────────────

let esAvailable = true;

async function indexLog(entry: LogEntry): Promise<void> {
  if (!ES_URL || !ES_LOG_ENABLED || !esAvailable) return;

  try {
    const res = await fetch(`${ES_URL}/ellie-logs/_doc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      // Don't recurse — just console.warn
      const text = await res.text();
      console.warn(`[logger] ES index failed: ${res.status} ${text.substring(0, 100)}`);
    }
  } catch {
    // Disable ES logging for 60s on connection failure
    esAvailable = false;
    console.warn("[logger] ES unreachable, disabling log indexing for 60s");
    setTimeout(() => { esAvailable = true; }, 60_000);
  }
}

// ── Error serialization ──────────────────────────────────────

function serializeError(err: unknown): LogEntry["error"] | undefined {
  if (!err) return undefined;
  if (err instanceof Error) {
    return {
      message: err.message,
      stack: err.stack,
      name: err.name,
    };
  }
  if (typeof err === "string") {
    return { message: err };
  }
  return { message: String(err) };
}

// ── Core log function ────────────────────────────────────────

function emitLog(
  level: LogLevel,
  module: string,
  message: string,
  contextOrError?: LogContext | Error | unknown,
  maybeError?: unknown
): void {
  if (!shouldLog(level)) return;

  // Parse arguments: (message, context, error) or (message, error) or (message)
  let context: LogContext | undefined;
  let error: unknown;

  if (contextOrError instanceof Error) {
    error = contextOrError;
  } else if (contextOrError && typeof contextOrError === "object" && !Array.isArray(contextOrError)) {
    context = contextOrError as LogContext;
    error = maybeError;
  } else if (contextOrError !== undefined) {
    error = contextOrError;
  }

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    module,
    message,
  };

  // ELLIE-398: Auto-inject trace ID from async context
  const traceId = context?.trace_id as string || getTraceId();
  if (traceId) entry.trace_id = traceId;

  // Extract correlation IDs from context
  if (context) {
    if (context.conversation_id) entry.conversation_id = context.conversation_id as string;
    if (context.session_id) entry.session_id = context.session_id as string;
    if (context.work_item_id) entry.work_item_id = context.work_item_id as string;

    // Remaining context fields
    const { conversation_id, session_id, work_item_id, trace_id: _t, ...rest } = context;
    if (Object.keys(rest).length > 0) entry.context = rest;
  }

  if (error) entry.error = serializeError(error);

  // Console output — human-readable with bracket prefix for compatibility
  const prefix = `[${module}]`;
  const traceStr = entry.trace_id ? ` [t:${entry.trace_id.slice(0, 8)}]` : "";
  const contextStr = entry.context ? ` ${JSON.stringify(entry.context)}` : "";
  const errorStr = entry.error ? ` ${entry.error.message}` : "";

  switch (level) {
    case "debug":
      console.log(`${prefix}${traceStr} ${message}${contextStr}${errorStr}`);
      break;
    case "info":
      console.log(`${prefix}${traceStr} ${message}${contextStr}${errorStr}`);
      break;
    case "warn":
      console.warn(`${prefix}${traceStr} ${message}${contextStr}${errorStr}`);
      break;
    case "error":
    case "fatal":
      console.error(`${prefix}${traceStr} ${message}${contextStr}${errorStr}`);
      break;
  }

  // Index warn/error/fatal to ES
  if (level === "warn" || level === "error" || level === "fatal") {
    indexLog(entry).catch(() => {});
  }
}

// ── Logger interface ─────────────────────────────────────────

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, contextOrError?: LogContext | Error | unknown, maybeError?: unknown): void;
  error(message: string, contextOrError?: LogContext | Error | unknown, maybeError?: unknown): void;
  fatal(message: string, contextOrError?: LogContext | Error | unknown, maybeError?: unknown): void;
  child(module: string): Logger;
}

function createLogger(module: string): Logger {
  return {
    debug: (msg, ctx?) => emitLog("debug", module, msg, ctx),
    info: (msg, ctx?) => emitLog("info", module, msg, ctx),
    warn: (msg, ctxOrErr?, err?) => emitLog("warn", module, msg, ctxOrErr, err),
    error: (msg, ctxOrErr?, err?) => emitLog("error", module, msg, ctxOrErr, err),
    fatal: (msg, ctxOrErr?, err?) => emitLog("fatal", module, msg, ctxOrErr, err),
    child: (childModule: string) => createLogger(childModule),
  };
}

/** Global logger — use log.child("module") for module-scoped loggers. */
export const log = createLogger("relay");
