/**
 * Agent Exchange — ELLIE-601
 *
 * Direct agent-to-agent communication channel with approval gate.
 * After coordinator approval (ELLIE-600), agents communicate directly
 * without routing through the coordinator. The coordinator receives
 * progress events: exchange started, completed, elapsed time.
 *
 * Flow:
 *  1. Coordinator approves agent request (ELLIE-600)
 *  2. openExchange() creates a direct channel with context handoff
 *  3. Agents exchange messages directly (addMessage)
 *  4. completeExchange() closes channel with summary
 *  5. Coordinator notified of start, completion, and duration
 *
 * Pure module — in-memory store, zero external side effects.
 */

import { randomUUID } from "crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export type ExchangeStatus = "active" | "completed" | "timed_out" | "cancelled";

export type ExchangeEventType =
  | "exchange-opened"
  | "exchange-message"
  | "exchange-completed"
  | "exchange-timed-out"
  | "exchange-cancelled";

/** A message within a direct exchange. */
export interface ExchangeMessage {
  from: string;
  content: string;
  timestamp: string;
}

/** A direct agent-to-agent exchange channel. */
export interface AgentExchange {
  id: string;
  agentRequestId: string;
  requestingAgent: string;
  targetAgent: string;
  status: ExchangeStatus;
  context: string;
  messages: ExchangeMessage[];
  openedAt: string;
  completedAt?: string;
  completionSummary?: string;
  elapsedMs?: number;
}

/** Input for opening an exchange. */
export interface OpenExchangeInput {
  agentRequestId: string;
  requestingAgent: string;
  targetAgent: string;
  context: string;
}

/** Event emitted for coordinator visibility. */
export interface ExchangeEvent {
  type: ExchangeEventType;
  exchangeId: string;
  timestamp: string;
  details: Record<string, unknown>;
}

/** Result of completing an exchange. */
export interface ExchangeCompletionResult {
  exchange: AgentExchange;
  event: ExchangeEvent;
  elapsedMs: number;
  messageCount: number;
}

// ── Configuration ────────────────────────────────────────────────────────────

/** Default exchange timeout: 10 minutes. */
export const DEFAULT_EXCHANGE_TIMEOUT_MS = 10 * 60 * 1000;

// ── Storage ──────────────────────────────────────────────────────────────────

const _exchanges = new Map<string, AgentExchange>();
const _events: ExchangeEvent[] = [];

// ── Exchange lifecycle ───────────────────────────────────────────────────────

/**
 * Open a direct exchange between two agents.
 * Called after coordinator approval.
 * The context field carries minimal relevant context (not full history).
 */
export function openExchange(input: OpenExchangeInput): {
  exchange: AgentExchange;
  event: ExchangeEvent;
} {
  const now = new Date().toISOString();
  const exchange: AgentExchange = {
    id: randomUUID(),
    agentRequestId: input.agentRequestId,
    requestingAgent: input.requestingAgent,
    targetAgent: input.targetAgent,
    status: "active",
    context: input.context,
    messages: [],
    openedAt: now,
  };

  _exchanges.set(exchange.id, exchange);

  const event = recordEvent("exchange-opened", exchange.id, {
    requestingAgent: input.requestingAgent,
    targetAgent: input.targetAgent,
    agentRequestId: input.agentRequestId,
  });

  return { exchange, event };
}

/**
 * Add a message to an active exchange.
 * Returns the updated exchange, or null if exchange not found/not active.
 */
export function addMessage(
  exchangeId: string,
  from: string,
  content: string,
): AgentExchange | null {
  const exchange = _exchanges.get(exchangeId);
  if (!exchange || exchange.status !== "active") return null;

  const message: ExchangeMessage = {
    from,
    content,
    timestamp: new Date().toISOString(),
  };

  const updated: AgentExchange = {
    ...exchange,
    messages: [...exchange.messages, message],
  };
  _exchanges.set(exchangeId, updated);

  recordEvent("exchange-message", exchangeId, {
    from,
    messageIndex: updated.messages.length - 1,
  });

  return updated;
}

/**
 * Complete an exchange with a summary of what was resolved.
 * Calculates elapsed time and notifies coordinator.
 */
export function completeExchange(
  exchangeId: string,
  summary: string,
  now?: Date,
): ExchangeCompletionResult | null {
  const exchange = _exchanges.get(exchangeId);
  if (!exchange || exchange.status !== "active") return null;

  const completedAt = now ?? new Date();
  const elapsedMs = completedAt.getTime() - new Date(exchange.openedAt).getTime();

  const updated: AgentExchange = {
    ...exchange,
    status: "completed",
    completedAt: completedAt.toISOString(),
    completionSummary: summary,
    elapsedMs,
  };
  _exchanges.set(exchangeId, updated);

  const event = recordEvent("exchange-completed", exchangeId, {
    requestingAgent: exchange.requestingAgent,
    targetAgent: exchange.targetAgent,
    summary,
    elapsedMs,
    messageCount: updated.messages.length,
  });

  return {
    exchange: updated,
    event,
    elapsedMs,
    messageCount: updated.messages.length,
  };
}

/**
 * Cancel an active exchange.
 */
export function cancelExchange(exchangeId: string, reason?: string): AgentExchange | null {
  const exchange = _exchanges.get(exchangeId);
  if (!exchange || exchange.status !== "active") return null;

  const updated: AgentExchange = {
    ...exchange,
    status: "cancelled",
    completedAt: new Date().toISOString(),
    elapsedMs: Date.now() - new Date(exchange.openedAt).getTime(),
  };
  _exchanges.set(exchangeId, updated);

  recordEvent("exchange-cancelled", exchangeId, {
    requestingAgent: exchange.requestingAgent,
    targetAgent: exchange.targetAgent,
    reason: reason ?? "cancelled",
  });

  return updated;
}

/**
 * Time out active exchanges that exceed the timeout.
 * Returns the number of exchanges timed out.
 */
export function timeoutExchanges(
  timeoutMs: number = DEFAULT_EXCHANGE_TIMEOUT_MS,
  now?: Date,
): number {
  const cutoff = (now ?? new Date()).getTime() - timeoutMs;
  let count = 0;

  for (const [id, exchange] of _exchanges) {
    if (exchange.status === "active" && new Date(exchange.openedAt).getTime() <= cutoff) {
      const elapsed = (now ?? new Date()).getTime() - new Date(exchange.openedAt).getTime();
      _exchanges.set(id, {
        ...exchange,
        status: "timed_out",
        completedAt: new Date().toISOString(),
        elapsedMs: elapsed,
      });
      recordEvent("exchange-timed-out", id, {
        requestingAgent: exchange.requestingAgent,
        targetAgent: exchange.targetAgent,
        elapsedMs: elapsed,
      });
      count++;
    }
  }

  return count;
}

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * Get an exchange by ID.
 */
export function getExchange(exchangeId: string): AgentExchange | null {
  return _exchanges.get(exchangeId) ?? null;
}

/**
 * List exchanges, optionally filtered by status.
 */
export function listExchanges(status?: ExchangeStatus): AgentExchange[] {
  const all = [..._exchanges.values()];
  if (!status) return all;
  return all.filter(e => e.status === status);
}

/**
 * Get the exchange for a given agent request.
 */
export function getExchangeByRequest(agentRequestId: string): AgentExchange | null {
  for (const exchange of _exchanges.values()) {
    if (exchange.agentRequestId === agentRequestId) return exchange;
  }
  return null;
}

/**
 * Get events for a specific exchange.
 */
export function getExchangeEvents(exchangeId: string): ExchangeEvent[] {
  return _events.filter(e => e.exchangeId === exchangeId);
}

// ── Context handoff ──────────────────────────────────────────────────────────

/**
 * Build a minimal context handoff for the target agent.
 * Includes only what the target needs to fulfill the request.
 */
export function buildContextHandoff(
  requestingAgent: string,
  targetAgent: string,
  reason: string,
  context: string,
): string {
  return [
    `Direct request from ${requestingAgent}:`,
    `Task: ${reason}`,
    `Context:`,
    context,
    `Respond directly to ${requestingAgent} when complete.`,
  ].join("\n");
}

// ── Coordinator visibility ───────────────────────────────────────────────────

/**
 * Build a summary of active exchanges for coordinator prompt injection.
 * Returns null if no active exchanges.
 */
export function buildActiveExchangesSection(exchanges: AgentExchange[]): string | null {
  if (exchanges.length === 0) return null;

  const lines: string[] = [`\nACTIVE AGENT EXCHANGES (${exchanges.length}):`];
  lines.push("Direct agent-to-agent communication in progress.");

  for (const ex of exchanges) {
    const elapsed = Date.now() - new Date(ex.openedAt).getTime();
    const elapsedSec = Math.round(elapsed / 1000);
    const elapsedLabel = elapsedSec < 60
      ? `${elapsedSec}s`
      : `${Math.round(elapsedSec / 60)}m`;
    lines.push(
      `- ${ex.requestingAgent} ↔ ${ex.targetAgent}: ${ex.messages.length} messages, ${elapsedLabel} elapsed`,
    );
  }

  return lines.join("\n");
}

/**
 * Build a completion notification for the coordinator.
 */
export function buildCompletionNotification(result: ExchangeCompletionResult): string {
  const elapsedSec = Math.round(result.elapsedMs / 1000);
  const elapsedLabel = elapsedSec < 60
    ? `${elapsedSec}s`
    : `${Math.round(elapsedSec / 60)}m`;
  return [
    `Exchange complete: ${result.exchange.requestingAgent} ↔ ${result.exchange.targetAgent}`,
    `Duration: ${elapsedLabel}, ${result.messageCount} messages`,
    `Summary: ${result.exchange.completionSummary}`,
  ].join("\n");
}

// ── Events (internal) ────────────────────────────────────────────────────────

function recordEvent(
  type: ExchangeEventType,
  exchangeId: string,
  details: Record<string, unknown>,
): ExchangeEvent {
  const entry: ExchangeEvent = {
    type,
    exchangeId,
    timestamp: new Date().toISOString(),
    details,
  };
  _events.push(entry);
  return entry;
}

// ── Testing ──────────────────────────────────────────────────────────────────

/** Reset all state — for testing only. */
export function _resetExchangesForTesting(): void {
  _exchanges.clear();
  _events.length = 0;
}
