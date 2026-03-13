/**
 * Round Table Router Integration — ELLIE-701
 *
 * Wires the round table system into the agent routing pipeline.
 * Responsibilities:
 *   1. Detect queries that should trigger a round table session
 *   2. Manage active round table session state (start, resume, complete)
 *   3. Provide hand-off interface from agent router to round table orchestrator
 *   4. Support explicit triggers ("/roundtable", "convene the round table")
 *      and automatic triggers (complex multi-domain queries)
 *
 * All external dependencies (orchestrator, session store) are injectable.
 */

import { log } from "../logger.ts";
import type { ConveneOutput } from "./convene.ts";
import { analyzeQuery, type QueryAnalysis } from "./convene.ts";

const logger = log.child("round-table-router");

// ── Types ───────────────────────────────────────────────────────

/** Result of round table detection — should we trigger a round table? */
export interface RoundTableDetection {
  /** Whether to trigger a round table. */
  shouldTrigger: boolean;
  /** Why the round table was triggered (or not). */
  reason: string;
  /** Detection method used. */
  method: "explicit" | "auto" | "handoff" | "none";
  /** Confidence in the detection (0-1). */
  confidence: number;
  /** The stripped query (without trigger phrases). */
  strippedQuery: string;
}

/** An active round table session tracked by the router. */
export interface ActiveRoundTableSession {
  sessionId: string;
  query: string;
  channel: string;
  workItemId?: string;
  startedAt: Date;
  status: "active" | "completed" | "failed";
  /** Output from the round table, available after completion. */
  output?: string;
}

/** Result of a round table hand-off. */
export interface RoundTableHandoffResult {
  /** Whether the hand-off was accepted. */
  accepted: boolean;
  /** The round table session ID (if accepted). */
  sessionId?: string;
  /** The final output (if completed synchronously). */
  output?: string;
  /** Error message if the hand-off failed. */
  error?: string;
}

/** Injectable function that runs a round table session. */
export type RunRoundTableFn = (
  query: string,
  opts?: {
    channel?: string;
    workItemId?: string;
    initiatorAgent?: string;
  },
) => Promise<{ sessionId: string; output: string; success: boolean; error?: string }>;

/** Injectable dependencies for the round table router integration. */
export interface RoundTableRouterDeps {
  /** Run a round table session end-to-end. */
  runRoundTable: RunRoundTableFn;
}

/** Configuration for round table detection. */
export interface RoundTableRouterConfig {
  /** Minimum complexity score to auto-trigger. Default: "complex". */
  autoTriggerComplexity: "simple" | "moderate" | "complex";
  /** Minimum number of domains to auto-trigger. Default: 2. */
  autoTriggerMinDomains: number;
  /** Minimum number of dimensions to auto-trigger. Default: 3. */
  autoTriggerMinDimensions: number;
  /** Whether auto-detection is enabled. Default: true. */
  autoDetectEnabled: boolean;
  /** Maximum concurrent round table sessions. Default: 3. */
  maxConcurrentSessions: number;
}

const DEFAULT_CONFIG: RoundTableRouterConfig = {
  autoTriggerComplexity: "complex",
  autoTriggerMinDomains: 2,
  autoTriggerMinDimensions: 3,
  autoDetectEnabled: true,
  maxConcurrentSessions: 3,
};

// ── Explicit Trigger Detection ──────────────────────────────────

/** Patterns that explicitly request a round table session. */
const EXPLICIT_TRIGGERS: { pattern: RegExp; strip: RegExp }[] = [
  { pattern: /^\/roundtable\b/i, strip: /^\/roundtable\s*/i },
  { pattern: /^\/round-table\b/i, strip: /^\/round-table\s*/i },
  { pattern: /^\/rt\b/i, strip: /^\/rt\s*/i },
  { pattern: /\bconvene\s+(the\s+)?round\s*table\b/i, strip: /\bconvene\s+(the\s+)?round\s*table\s*/i },
  { pattern: /\bstart\s+(a\s+)?round\s*table\b/i, strip: /\bstart\s+(a\s+)?round\s*table\s*/i },
  { pattern: /\bround\s*table\s+(on|about|for|regarding)\b/i, strip: /\bround\s*table\s+(on|about|for|regarding)\s*/i },
  { pattern: /\bget\s+(all|every)\s+(agent|formation)s?\s+(to\s+)?(weigh\s+in|discuss|analyze)\b/i, strip: /\bget\s+(all|every)\s+(agent|formation)s?\s+(to\s+)?(weigh\s+in|discuss|analyze)\s*(on|about)?\s*/i },
];

/**
 * Check if a message explicitly requests a round table.
 */
export function detectExplicitTrigger(message: string): { triggered: boolean; strippedQuery: string } {
  for (const { pattern, strip } of EXPLICIT_TRIGGERS) {
    if (pattern.test(message)) {
      const stripped = message.replace(strip, "").trim();
      return { triggered: true, strippedQuery: stripped || message };
    }
  }
  return { triggered: false, strippedQuery: message };
}

// ── Auto Detection ──────────────────────────────────────────────

/** Complexity levels ranked for comparison. */
const COMPLEXITY_RANK: Record<string, number> = {
  simple: 1,
  moderate: 2,
  complex: 3,
};

/**
 * Detect if a query should automatically trigger a round table
 * based on query analysis (complexity, domain count, dimensions).
 */
export function detectAutoTrigger(
  analysis: QueryAnalysis,
  config: RoundTableRouterConfig = DEFAULT_CONFIG,
): { triggered: boolean; reason: string; confidence: number } {
  if (!config.autoDetectEnabled) {
    return { triggered: false, reason: "Auto-detection disabled", confidence: 0 };
  }

  const complexityRank = COMPLEXITY_RANK[analysis.complexity] ?? 1;
  const thresholdRank = COMPLEXITY_RANK[config.autoTriggerComplexity] ?? 3;
  const domainCount = analysis.domains.length;
  const dimensionCount = analysis.dimensions.length;

  // Score-based approach: accumulate evidence
  let score = 0;
  const reasons: string[] = [];

  // Complexity match
  if (complexityRank >= thresholdRank) {
    score += 2;
    reasons.push(`complexity=${analysis.complexity}`);
  }

  // Multi-domain
  if (domainCount >= config.autoTriggerMinDomains) {
    score += 2;
    reasons.push(`domains=${domainCount}`);
  }

  // Multi-dimensional
  if (dimensionCount >= config.autoTriggerMinDimensions) {
    score += 1;
    reasons.push(`dimensions=${dimensionCount}`);
  }

  // Decision intent boosts score (round tables are ideal for decisions)
  if (analysis.intent.toLowerCase().includes("decide") || analysis.intent.toLowerCase().includes("decision")) {
    score += 1;
    reasons.push("decision-intent");
  }

  // Threshold: need at least 3 points (complexity+domain or complexity+dimensions+intent)
  const triggered = score >= 3;
  const confidence = Math.min(score / 5, 1.0);

  return {
    triggered,
    reason: triggered
      ? `Auto-triggered: ${reasons.join(", ")}`
      : `Below threshold (score=${score}): ${reasons.join(", ") || "no signals"}`,
    confidence,
  };
}

// ── Agent Hand-off Detection ────────────────────────────────────

/** Patterns in agent output that indicate a hand-off to round table. */
const HANDOFF_PATTERNS = [
  /\[ROUND[_\s-]TABLE\]/i,
  /\bescalat(?:e|ing)\s+to\s+round\s*table\b/i,
  /\bneed(?:s)?\s+(?:a\s+)?round\s*table\b/i,
  /\brecommend(?:ing)?\s+(?:a\s+)?round\s*table\b/i,
  /\btrigger(?:ing)?\s+(?:a\s+)?round\s*table\b/i,
];

/**
 * Detect if an agent's response is requesting a hand-off to the round table.
 */
export function detectHandoff(agentResponse: string): { triggered: boolean; reason: string } {
  for (const pattern of HANDOFF_PATTERNS) {
    const match = agentResponse.match(pattern);
    if (match) {
      return { triggered: true, reason: `Agent hand-off: "${match[0]}"` };
    }
  }
  return { triggered: false, reason: "No hand-off detected" };
}

// ── Combined Detection ──────────────────────────────────────────

/**
 * Run all detection methods on a user message.
 * Priority: explicit trigger > auto detection.
 */
export function detectRoundTable(
  message: string,
  config?: Partial<RoundTableRouterConfig>,
): RoundTableDetection {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // 1. Check explicit triggers first
  const explicit = detectExplicitTrigger(message);
  if (explicit.triggered) {
    return {
      shouldTrigger: true,
      reason: "Explicit round table request",
      method: "explicit",
      confidence: 1.0,
      strippedQuery: explicit.strippedQuery,
    };
  }

  // 2. Run query analysis for auto-detection
  const analysis = analyzeQuery(message);
  const auto = detectAutoTrigger(analysis, cfg);
  if (auto.triggered) {
    return {
      shouldTrigger: true,
      reason: auto.reason,
      method: "auto",
      confidence: auto.confidence,
      strippedQuery: message,
    };
  }

  return {
    shouldTrigger: false,
    reason: auto.reason,
    method: "none",
    confidence: 0,
    strippedQuery: message,
  };
}

// ── Session Management ──────────────────────────────────────────

/**
 * In-memory store for active round table sessions.
 * Production would use the DB-backed session store from round-table types,
 * but this provides the router-level tracking needed for concurrency control
 * and session resumption.
 */
export class RoundTableSessionManager {
  private sessions = new Map<string, ActiveRoundTableSession>();
  private config: RoundTableRouterConfig;

  constructor(config?: Partial<RoundTableRouterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Get an active session by ID. */
  getSession(sessionId: string): ActiveRoundTableSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /** Get an active session for a given channel. */
  getActiveSessionForChannel(channel: string): ActiveRoundTableSession | null {
    for (const session of this.sessions.values()) {
      if (session.channel === channel && session.status === "active") {
        return session;
      }
    }
    return null;
  }

  /** Get all active sessions. */
  getActiveSessions(): ActiveRoundTableSession[] {
    return Array.from(this.sessions.values()).filter(s => s.status === "active");
  }

  /** Check if a new session can be started (concurrency limit). */
  canStartSession(): boolean {
    const active = this.getActiveSessions();
    return active.length < this.config.maxConcurrentSessions;
  }

  /** Register a new round table session. */
  registerSession(
    sessionId: string,
    query: string,
    channel: string,
    workItemId?: string,
  ): ActiveRoundTableSession {
    const session: ActiveRoundTableSession = {
      sessionId,
      query,
      channel,
      workItemId,
      startedAt: new Date(),
      status: "active",
    };
    this.sessions.set(sessionId, session);
    logger.info("Round table session registered", { sessionId, channel });
    return session;
  }

  /** Mark a session as completed. */
  completeSession(sessionId: string, output: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = "completed";
      session.output = output;
      logger.info("Round table session completed", { sessionId });
    }
  }

  /** Mark a session as failed. */
  failSession(sessionId: string, error: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = "failed";
      session.output = error;
      logger.info("Round table session failed", { sessionId, error });
    }
  }

  /** Clean up completed/failed sessions older than the given age in ms. */
  cleanup(maxAgeMs: number = 30 * 60_000): number {
    const cutoff = new Date(Date.now() - maxAgeMs);
    let cleaned = 0;
    for (const [id, session] of this.sessions) {
      if (session.status !== "active" && session.startedAt < cutoff) {
        this.sessions.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info("Cleaned up round table sessions", { cleaned });
    }
    return cleaned;
  }
}

// ── Hand-off Executor ───────────────────────────────────────────

/**
 * Execute a round table hand-off — the main integration point.
 *
 * Called by the agent router when a round table is detected. Handles:
 *   1. Concurrency check
 *   2. Session registration
 *   3. Round table execution
 *   4. Session completion/failure
 *   5. Result return
 */
export async function executeRoundTableHandoff(
  deps: RoundTableRouterDeps,
  manager: RoundTableSessionManager,
  query: string,
  opts?: {
    channel?: string;
    workItemId?: string;
    initiatorAgent?: string;
  },
): Promise<RoundTableHandoffResult> {
  const channel = opts?.channel ?? "internal";

  // Check concurrency limit
  if (!manager.canStartSession()) {
    logger.warn("Round table rejected: concurrency limit reached");
    return {
      accepted: false,
      error: "Maximum concurrent round table sessions reached. Please wait for an active session to complete.",
    };
  }

  // Check for existing active session on this channel
  const existing = manager.getActiveSessionForChannel(channel);
  if (existing) {
    logger.info("Active round table session exists on channel", {
      sessionId: existing.sessionId,
      channel,
    });
    return {
      accepted: false,
      sessionId: existing.sessionId,
      error: `A round table session is already active on this channel (${existing.sessionId}).`,
    };
  }

  logger.info("Starting round table hand-off", { query: query.slice(0, 100), channel });

  try {
    // Execute the round table
    const result = await deps.runRoundTable(query, {
      channel,
      workItemId: opts?.workItemId,
      initiatorAgent: opts?.initiatorAgent,
    });

    // Register and complete in one go (synchronous execution model)
    const session = manager.registerSession(result.sessionId, query, channel, opts?.workItemId);

    if (result.success) {
      manager.completeSession(result.sessionId, result.output);
      return {
        accepted: true,
        sessionId: result.sessionId,
        output: result.output,
      };
    } else {
      manager.failSession(result.sessionId, result.error ?? "Unknown error");
      return {
        accepted: true,
        sessionId: result.sessionId,
        error: result.error,
      };
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("Round table hand-off failed", { error: errorMsg });
    return {
      accepted: false,
      error: errorMsg,
    };
  }
}

// ── Testing Helpers ─────────────────────────────────────────────

/**
 * Create mock round table router deps.
 */
export function _makeMockRouterDeps(
  result?: { sessionId: string; output: string; success: boolean; error?: string },
): RoundTableRouterDeps {
  return {
    runRoundTable: async () =>
      result ?? {
        sessionId: "rt-session-1",
        output: "Round table complete: balanced expansion strategy recommended.",
        success: true,
      },
  };
}

/**
 * Create mock round table router deps that fail.
 */
export function _makeMockRouterDepsWithFailure(error: string): RoundTableRouterDeps {
  return {
    runRoundTable: async () => ({
      sessionId: "rt-session-fail",
      output: "",
      success: false,
      error,
    }),
  };
}

/**
 * Create mock round table router deps that throw.
 */
export function _makeMockRouterDepsWithThrow(error: string): RoundTableRouterDeps {
  return {
    runRoundTable: async () => { throw new Error(error); },
  };
}
