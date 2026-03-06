/**
 * Exchange Timeout Handler — ELLIE-602
 *
 * Monitors active inter-agent exchanges for timeouts and escalates
 * to the coordinator when exchanges hang. Integrates with:
 *   - agent-exchange.ts (ELLIE-601): exchange lifecycle
 *   - commitment-ledger.ts (ELLIE-598): sub-commitment cleanup
 *   - agent-request.ts (ELLIE-600): request lifecycle
 *
 * Grace period: default 2x estimated duration. If no estimate, uses
 * a flat default timeout.
 *
 * Pure module — in-memory store, zero external side effects.
 */

import {
  type AgentExchange,
  listExchanges,
  getExchangeByRequest,
} from "./agent-exchange";

import {
  type Commitment,
  listSubCommitments,
  resolveCommitment,
  listCommitments,
} from "./commitment-ledger";

// ── Types ────────────────────────────────────────────────────────────────────

export type EscalationAction = "ping_agent" | "abort_exchange" | "notify_coordinator";

export type EscalationSeverity = "warning" | "critical";

/** An escalation raised when an exchange exceeds its timeout. */
export interface ExchangeEscalation {
  exchangeId: string;
  requestingAgent: string;
  targetAgent: string;
  estimatedDurationMs: number | null;
  actualElapsedMs: number;
  gracePeriodMs: number;
  severity: EscalationSeverity;
  recommendedAction: EscalationAction;
  reason: string;
  timestamp: string;
}

/** Configuration for timeout detection. */
export interface TimeoutConfig {
  /** Multiplier applied to estimated duration to get grace period. Default: 2. */
  graceMultiplier: number;
  /** Flat timeout when no estimate is provided, in ms. Default: 10 minutes. */
  defaultTimeoutMs: number;
  /** Threshold above which escalation is critical (multiplier of total allowed time). Default: 3. */
  criticalMultiplier: number;
}

/** Result of a stale sub-commitment cleanup. */
export interface CleanupResult {
  sessionId: string;
  cleanedUp: number;
  commitments: Commitment[];
}

// ── Configuration ────────────────────────────────────────────────────────────

export const DEFAULT_TIMEOUT_CONFIG: TimeoutConfig = {
  graceMultiplier: 2,
  defaultTimeoutMs: 10 * 60 * 1000,
  criticalMultiplier: 3,
};

// ── Storage ──────────────────────────────────────────────────────────────────

const _escalations: ExchangeEscalation[] = [];

// ── Timeout detection ────────────────────────────────────────────────────────

/**
 * Calculate the allowed duration for an exchange.
 * If the exchange has an associated sub-commitment with estimatedDuration,
 * uses that × graceMultiplier. Otherwise uses defaultTimeoutMs.
 */
export function calculateAllowedDuration(
  estimatedDurationMinutes: number | null | undefined,
  config: TimeoutConfig = DEFAULT_TIMEOUT_CONFIG,
): { allowedMs: number; gracePeriodMs: number } {
  if (estimatedDurationMinutes != null && estimatedDurationMinutes > 0) {
    const estimatedMs = estimatedDurationMinutes * 60 * 1000;
    const gracePeriodMs = estimatedMs * (config.graceMultiplier - 1);
    return {
      allowedMs: estimatedMs + gracePeriodMs,
      gracePeriodMs,
    };
  }

  return {
    allowedMs: config.defaultTimeoutMs,
    gracePeriodMs: config.defaultTimeoutMs,
  };
}

/**
 * Check a single exchange for timeout.
 * Returns an escalation if the exchange has exceeded its allowed duration,
 * or null if still within bounds.
 */
export function checkExchangeTimeout(
  exchange: AgentExchange,
  estimatedDurationMinutes: number | null | undefined,
  config: TimeoutConfig = DEFAULT_TIMEOUT_CONFIG,
  now?: Date,
): ExchangeEscalation | null {
  if (exchange.status !== "active") return null;

  const currentTime = (now ?? new Date()).getTime();
  const elapsedMs = currentTime - new Date(exchange.openedAt).getTime();

  const { allowedMs, gracePeriodMs } = calculateAllowedDuration(
    estimatedDurationMinutes,
    config,
  );

  if (elapsedMs <= allowedMs) return null;

  const estimatedMs = estimatedDurationMinutes != null && estimatedDurationMinutes > 0
    ? estimatedDurationMinutes * 60 * 1000
    : null;

  // Determine severity: critical if elapsed > criticalMultiplier × allowed
  const criticalThreshold = allowedMs * config.criticalMultiplier;
  const severity: EscalationSeverity = elapsedMs > criticalThreshold ? "critical" : "warning";

  // Recommend action based on severity
  const recommendedAction: EscalationAction = severity === "critical"
    ? "abort_exchange"
    : "ping_agent";

  return {
    exchangeId: exchange.id,
    requestingAgent: exchange.requestingAgent,
    targetAgent: exchange.targetAgent,
    estimatedDurationMs: estimatedMs,
    actualElapsedMs: elapsedMs,
    gracePeriodMs,
    severity,
    recommendedAction,
    reason: buildEscalationReason(exchange, elapsedMs, allowedMs, severity),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Scan all active exchanges for timeouts.
 * Looks up associated sub-commitments for estimated durations.
 * Returns escalations for any exchanges that have exceeded their allowed time.
 */
export function detectTimeouts(
  sessionId: string,
  config: TimeoutConfig = DEFAULT_TIMEOUT_CONFIG,
  now?: Date,
): ExchangeEscalation[] {
  const activeExchanges = listExchanges("active");
  const escalations: ExchangeEscalation[] = [];

  for (const exchange of activeExchanges) {
    // Find the sub-commitment associated with this exchange's agent request
    const estimatedDuration = findEstimatedDuration(sessionId, exchange);

    const escalation = checkExchangeTimeout(exchange, estimatedDuration, config, now);
    if (escalation) {
      _escalations.push(escalation);
      escalations.push(escalation);
    }
  }

  return escalations;
}

/**
 * Find the estimated duration for an exchange by looking up its
 * associated sub-commitment in the ledger.
 */
export function findEstimatedDuration(
  sessionId: string,
  exchange: AgentExchange,
): number | null {
  // Look through all commitments for one matching this exchange
  const commitments = listCommitments(sessionId);
  for (const c of commitments) {
    if (
      c.targetAgent === exchange.targetAgent &&
      c.requestingAgent === exchange.requestingAgent &&
      c.status === "pending" &&
      c.estimatedDuration != null
    ) {
      return c.estimatedDuration;
    }
  }
  return null;
}

// ── Sub-commitment cleanup ───────────────────────────────────────────────────

/**
 * Clean up stale sub-commitments when a parent session ends.
 * Resolves any pending sub-commitments that don't have an active exchange.
 */
export function cleanupStaleSubCommitments(
  sessionId: string,
  parentCommitmentId: string,
  turnResolved: number,
): CleanupResult {
  const pendingSubs = listSubCommitments(sessionId, parentCommitmentId, "pending");
  const cleaned: Commitment[] = [];

  for (const sub of pendingSubs) {
    // Check if this sub-commitment has an active exchange
    const exchange = findExchangeForSubCommitment(sub);
    const isActive = exchange != null && exchange.status === "active";

    if (!isActive) {
      const resolved = resolveCommitment(sessionId, sub.id, turnResolved);
      if (resolved) {
        cleaned.push(resolved);
      }
    }
  }

  return {
    sessionId,
    cleanedUp: cleaned.length,
    commitments: cleaned,
  };
}

/**
 * Find the exchange associated with a sub-commitment (if any).
 */
function findExchangeForSubCommitment(commitment: Commitment): AgentExchange | null {
  // Try looking up by agent request ID if available
  if (commitment.id) {
    const exchange = getExchangeByRequest(commitment.id);
    if (exchange) return exchange;
  }

  // Fallback: look through active exchanges for matching agents
  const activeExchanges = listExchanges("active");
  for (const ex of activeExchanges) {
    if (
      ex.requestingAgent === commitment.requestingAgent &&
      ex.targetAgent === commitment.targetAgent
    ) {
      return ex;
    }
  }

  return null;
}

// ── Coordinator notifications ────────────────────────────────────────────────

/**
 * Build an escalation notification for the coordinator prompt.
 */
export function buildEscalationNotification(escalation: ExchangeEscalation): string {
  const elapsedLabel = formatDuration(escalation.actualElapsedMs);
  const estimatedLabel = escalation.estimatedDurationMs
    ? formatDuration(escalation.estimatedDurationMs)
    : "no estimate";

  const actionLabel: Record<EscalationAction, string> = {
    ping_agent: `Ping ${escalation.targetAgent} for status`,
    abort_exchange: `Abort exchange and reassign`,
    notify_coordinator: `Review and decide`,
  };

  return [
    `EXCHANGE TIMEOUT [${escalation.severity.toUpperCase()}]:`,
    `${escalation.requestingAgent} -> ${escalation.targetAgent}`,
    `Elapsed: ${elapsedLabel} (estimated: ${estimatedLabel})`,
    `Action: ${actionLabel[escalation.recommendedAction]}`,
  ].join("\n");
}

/**
 * Build a section showing all pending escalations for coordinator prompt injection.
 * Returns null if no escalations.
 */
export function buildEscalationsSection(escalations: ExchangeEscalation[]): string | null {
  if (escalations.length === 0) return null;

  const critical = escalations.filter(e => e.severity === "critical");
  const warnings = escalations.filter(e => e.severity === "warning");

  const lines: string[] = [`\nEXCHANGE TIMEOUTS (${escalations.length}):`];

  if (critical.length > 0) {
    lines.push(`CRITICAL (${critical.length}):`);
    for (const e of critical) {
      lines.push(`- ${e.requestingAgent} -> ${e.targetAgent}: ${formatDuration(e.actualElapsedMs)} elapsed, recommend ABORT`);
    }
  }

  if (warnings.length > 0) {
    lines.push(`WARNING (${warnings.length}):`);
    for (const e of warnings) {
      lines.push(`- ${e.requestingAgent} -> ${e.targetAgent}: ${formatDuration(e.actualElapsedMs)} elapsed, recommend PING`);
    }
  }

  lines.push("Review and take action on timed-out exchanges.");
  return lines.join("\n");
}

/**
 * Build a cleanup summary for coordinator visibility.
 */
export function buildCleanupSummary(result: CleanupResult): string {
  if (result.cleanedUp === 0) {
    return `Session ${result.sessionId}: no stale sub-commitments to clean up.`;
  }

  const lines = [
    `Cleaned up ${result.cleanedUp} stale sub-commitment${result.cleanedUp > 1 ? "s" : ""} in session ${result.sessionId}:`,
  ];

  for (const c of result.commitments) {
    lines.push(`- ${c.description} (${c.requestingAgent} -> ${c.targetAgent})`);
  }

  return lines.join("\n");
}

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * Get all recorded escalations.
 */
export function getEscalations(): ExchangeEscalation[] {
  return [..._escalations];
}

/**
 * Get escalations for a specific exchange.
 */
export function getEscalationsForExchange(exchangeId: string): ExchangeEscalation[] {
  return _escalations.filter(e => e.exchangeId === exchangeId);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildEscalationReason(
  exchange: AgentExchange,
  elapsedMs: number,
  allowedMs: number,
  severity: EscalationSeverity,
): string {
  const overBy = formatDuration(elapsedMs - allowedMs);
  const msgCount = exchange.messages.length;
  const lastMsg = msgCount > 0
    ? ` Last message from ${exchange.messages[msgCount - 1].from}.`
    : " No messages exchanged.";

  return severity === "critical"
    ? `Exchange critically overdue by ${overBy}. ${msgCount} messages exchanged.${lastMsg}`
    : `Exchange overdue by ${overBy}. ${msgCount} messages exchanged.${lastMsg}`;
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remainMin = min % 60;
  return remainMin > 0 ? `${hr}h${remainMin}m` : `${hr}h`;
}

// ── Testing ──────────────────────────────────────────────────────────────────

/** Reset all state — for testing only. */
export function _resetTimeoutHandlerForTesting(): void {
  _escalations.length = 0;
}
