/**
 * Agent Exchange Tests — ELLIE-601
 *
 * Validates:
 *  - openExchange() creates active channel with context
 *  - addMessage() appends messages to active exchange
 *  - completeExchange() closes with summary, elapsed time, event
 *  - cancelExchange() cancels active exchange
 *  - timeoutExchanges() times out stale exchanges
 *  - getExchange/listExchanges/getExchangeByRequest queries
 *  - buildContextHandoff() formats minimal context
 *  - buildActiveExchangesSection() coordinator prompt injection
 *  - buildCompletionNotification() coordinator notification
 *  - getExchangeEvents() full event trail
 *  - Full scenario: open → messages → complete
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  openExchange,
  addMessage,
  completeExchange,
  cancelExchange,
  timeoutExchanges,
  getExchange,
  listExchanges,
  getExchangeByRequest,
  getExchangeEvents,
  buildContextHandoff,
  buildActiveExchangesSection,
  buildCompletionNotification,
  DEFAULT_EXCHANGE_TIMEOUT_MS,
  _resetExchangesForTesting,
} from "../src/agent-exchange.ts";

beforeEach(() => {
  _resetExchangesForTesting();
});

// ── openExchange ─────────────────────────────────────────────────────────────

describe("openExchange", () => {
  it("creates an active exchange", () => {
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Please review the auth module",
    });

    expect(exchange.id).toBeTruthy();
    expect(exchange.status).toBe("active");
    expect(exchange.requestingAgent).toBe("dev");
    expect(exchange.targetAgent).toBe("critic");
    expect(exchange.context).toBe("Please review the auth module");
    expect(exchange.messages).toHaveLength(0);
    expect(exchange.openedAt).toBeTruthy();
  });

  it("records exchange-opened event", () => {
    const { exchange, event } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Context",
    });

    expect(event.type).toBe("exchange-opened");
    expect(event.exchangeId).toBe(exchange.id);
    expect(event.details.requestingAgent).toBe("dev");
    expect(event.details.targetAgent).toBe("critic");
  });

  it("stores agentRequestId for linking", () => {
    const { exchange } = openExchange({
      agentRequestId: "req-42",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Context",
    });

    expect(exchange.agentRequestId).toBe("req-42");
  });

  it("is retrievable after opening", () => {
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Context",
    });

    expect(getExchange(exchange.id)).not.toBeNull();
  });
});

// ── addMessage ───────────────────────────────────────────────────────────────

describe("addMessage", () => {
  it("adds a message to active exchange", () => {
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review",
    });

    const updated = addMessage(exchange.id, "dev", "Can you check the auth handler?");
    expect(updated).not.toBeNull();
    expect(updated!.messages).toHaveLength(1);
    expect(updated!.messages[0].from).toBe("dev");
    expect(updated!.messages[0].content).toBe("Can you check the auth handler?");
  });

  it("adds multiple messages in sequence", () => {
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review",
    });

    addMessage(exchange.id, "dev", "Check auth handler");
    addMessage(exchange.id, "critic", "Found an issue with token validation");
    const updated = addMessage(exchange.id, "dev", "Thanks, I'll fix it");

    expect(updated!.messages).toHaveLength(3);
    expect(updated!.messages[1].from).toBe("critic");
  });

  it("returns null for nonexistent exchange", () => {
    expect(addMessage("fake", "dev", "Hello")).toBeNull();
  });

  it("returns null for completed exchange", () => {
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review",
    });

    completeExchange(exchange.id, "Done");
    expect(addMessage(exchange.id, "dev", "More?")).toBeNull();
  });

  it("records exchange-message event", () => {
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review",
    });

    addMessage(exchange.id, "dev", "Hello");
    const events = getExchangeEvents(exchange.id);
    expect(events.some(e => e.type === "exchange-message")).toBe(true);
  });

  it("does not mutate original exchange reference", () => {
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review",
    });

    const msgCount = exchange.messages.length;
    addMessage(exchange.id, "dev", "Hello");
    expect(exchange.messages.length).toBe(msgCount); // original unchanged
  });
});

// ── completeExchange ─────────────────────────────────────────────────────────

describe("completeExchange", () => {
  it("completes with summary and elapsed time", () => {
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review",
    });

    addMessage(exchange.id, "dev", "Check this");
    addMessage(exchange.id, "critic", "LGTM");

    const openedAt = new Date(exchange.openedAt);
    const completedAt = new Date(openedAt.getTime() + 30000); // 30s later
    const result = completeExchange(exchange.id, "Code review passed", completedAt);

    expect(result).not.toBeNull();
    expect(result!.exchange.status).toBe("completed");
    expect(result!.exchange.completionSummary).toBe("Code review passed");
    expect(result!.elapsedMs).toBe(30000);
    expect(result!.messageCount).toBe(2);
  });

  it("records exchange-completed event", () => {
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review",
    });

    completeExchange(exchange.id, "Done");
    const events = getExchangeEvents(exchange.id);
    expect(events.some(e => e.type === "exchange-completed")).toBe(true);
  });

  it("returns null for nonexistent exchange", () => {
    expect(completeExchange("fake", "Done")).toBeNull();
  });

  it("returns null for already-completed exchange", () => {
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review",
    });

    completeExchange(exchange.id, "First");
    expect(completeExchange(exchange.id, "Second")).toBeNull();
  });

  it("persists in storage", () => {
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review",
    });

    completeExchange(exchange.id, "Done");
    const found = getExchange(exchange.id);
    expect(found!.status).toBe("completed");
    expect(found!.completionSummary).toBe("Done");
  });
});

// ── cancelExchange ───────────────────────────────────────────────────────────

describe("cancelExchange", () => {
  it("cancels an active exchange", () => {
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review",
    });

    const result = cancelExchange(exchange.id, "No longer needed");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("cancelled");
  });

  it("records exchange-cancelled event", () => {
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review",
    });

    cancelExchange(exchange.id);
    const events = getExchangeEvents(exchange.id);
    expect(events.some(e => e.type === "exchange-cancelled")).toBe(true);
  });

  it("returns null for nonexistent exchange", () => {
    expect(cancelExchange("fake")).toBeNull();
  });

  it("returns null for completed exchange", () => {
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review",
    });

    completeExchange(exchange.id, "Done");
    expect(cancelExchange(exchange.id)).toBeNull();
  });
});

// ── timeoutExchanges ─────────────────────────────────────────────────────────

describe("timeoutExchanges", () => {
  it("times out stale exchanges", () => {
    openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review",
    });

    const count = timeoutExchanges(0);
    expect(count).toBe(1);
  });

  it("does not time out recent exchanges", () => {
    openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review",
    });

    const count = timeoutExchanges(60 * 60 * 1000);
    expect(count).toBe(0);
  });

  it("does not time out completed exchanges", () => {
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review",
    });

    completeExchange(exchange.id, "Done");
    const count = timeoutExchanges(0);
    expect(count).toBe(0);
  });

  it("sets status to timed_out", () => {
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review",
    });

    timeoutExchanges(0);
    expect(getExchange(exchange.id)!.status).toBe("timed_out");
  });

  it("records exchange-timed-out event", () => {
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review",
    });

    timeoutExchanges(0);
    const events = getExchangeEvents(exchange.id);
    expect(events.some(e => e.type === "exchange-timed-out")).toBe(true);
  });
});

// ── Queries ──────────────────────────────────────────────────────────────────

describe("getExchange", () => {
  it("returns exchange by ID", () => {
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review",
    });

    expect(getExchange(exchange.id)!.id).toBe(exchange.id);
  });

  it("returns null for unknown ID", () => {
    expect(getExchange("fake")).toBeNull();
  });
});

describe("listExchanges", () => {
  it("lists all exchanges", () => {
    openExchange({ agentRequestId: "r1", requestingAgent: "dev", targetAgent: "critic", context: "A" });
    openExchange({ agentRequestId: "r2", requestingAgent: "dev", targetAgent: "security", context: "B" });

    expect(listExchanges()).toHaveLength(2);
  });

  it("filters by status", () => {
    const { exchange } = openExchange({ agentRequestId: "r1", requestingAgent: "dev", targetAgent: "critic", context: "A" });
    openExchange({ agentRequestId: "r2", requestingAgent: "dev", targetAgent: "security", context: "B" });

    completeExchange(exchange.id, "Done");

    expect(listExchanges("active")).toHaveLength(1);
    expect(listExchanges("completed")).toHaveLength(1);
  });
});

describe("getExchangeByRequest", () => {
  it("finds exchange by agent request ID", () => {
    openExchange({ agentRequestId: "req-42", requestingAgent: "dev", targetAgent: "critic", context: "Review" });

    const found = getExchangeByRequest("req-42");
    expect(found).not.toBeNull();
    expect(found!.agentRequestId).toBe("req-42");
  });

  it("returns null for unknown request ID", () => {
    expect(getExchangeByRequest("fake")).toBeNull();
  });
});

describe("getExchangeEvents", () => {
  it("returns all events for an exchange", () => {
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review",
    });

    addMessage(exchange.id, "dev", "Hello");
    completeExchange(exchange.id, "Done");

    const events = getExchangeEvents(exchange.id);
    expect(events).toHaveLength(3); // opened + message + completed
  });

  it("returns empty for unknown exchange", () => {
    expect(getExchangeEvents("fake")).toHaveLength(0);
  });
});

// ── buildContextHandoff ──────────────────────────────────────────────────────

describe("buildContextHandoff", () => {
  it("formats minimal context for target agent", () => {
    const handoff = buildContextHandoff(
      "dev",
      "critic",
      "Review auth module",
      "The auth module at src/auth.ts handles JWT validation.",
    );

    expect(handoff).toContain("Direct request from dev");
    expect(handoff).toContain("Task: Review auth module");
    expect(handoff).toContain("JWT validation");
    expect(handoff).toContain("Respond directly to dev");
  });
});

// ── buildActiveExchangesSection ──────────────────────────────────────────────

describe("buildActiveExchangesSection", () => {
  it("returns null for empty list", () => {
    expect(buildActiveExchangesSection([])).toBeNull();
  });

  it("formats active exchanges for coordinator", () => {
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review",
    });

    addMessage(exchange.id, "dev", "Hello");
    addMessage(exchange.id, "critic", "Hi");

    const active = listExchanges("active");
    const section = buildActiveExchangesSection(active);

    expect(section).not.toBeNull();
    expect(section).toContain("ACTIVE AGENT EXCHANGES (1)");
    expect(section).toContain("dev ↔ critic");
    expect(section).toContain("2 messages");
  });

  it("shows multiple exchanges", () => {
    openExchange({ agentRequestId: "r1", requestingAgent: "dev", targetAgent: "critic", context: "A" });
    openExchange({ agentRequestId: "r2", requestingAgent: "dev", targetAgent: "security", context: "B" });

    const section = buildActiveExchangesSection(listExchanges("active"));
    expect(section).toContain("ACTIVE AGENT EXCHANGES (2)");
    expect(section).toContain("dev ↔ critic");
    expect(section).toContain("dev ↔ security");
  });
});

// ── buildCompletionNotification ──────────────────────────────────────────────

describe("buildCompletionNotification", () => {
  it("formats completion notification", () => {
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review",
    });

    addMessage(exchange.id, "dev", "Check this");
    addMessage(exchange.id, "critic", "LGTM");

    const openedAt = new Date(exchange.openedAt);
    const result = completeExchange(exchange.id, "Code review passed", new Date(openedAt.getTime() + 45000))!;
    const notification = buildCompletionNotification(result);

    expect(notification).toContain("dev ↔ critic");
    expect(notification).toContain("45s");
    expect(notification).toContain("2 messages");
    expect(notification).toContain("Code review passed");
  });

  it("formats minutes for longer exchanges", () => {
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review",
    });

    const openedAt = new Date(exchange.openedAt);
    const result = completeExchange(exchange.id, "Done", new Date(openedAt.getTime() + 180000))!; // 3 min
    const notification = buildCompletionNotification(result);

    expect(notification).toContain("3m");
  });
});

// ── Full scenario ────────────────────────────────────────────────────────────

describe("full exchange scenario", () => {
  it("open → messages → complete with full event trail", () => {
    // 1. Open exchange after coordinator approval
    const { exchange } = openExchange({
      agentRequestId: "req-review-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Auth module needs code review before merge",
    });
    expect(exchange.status).toBe("active");

    // 2. Build context handoff for target
    const handoff = buildContextHandoff(
      "dev", "critic",
      "Code review on auth module",
      "Auth module at src/auth.ts. Key concern: JWT expiry handling.",
    );
    expect(handoff).toContain("JWT expiry");

    // 3. Exchange messages directly
    addMessage(exchange.id, "dev", "Please review the JWT expiry logic in auth.ts:45-60");
    addMessage(exchange.id, "critic", "Line 52 has a potential timezone issue. The expiry check uses local time.");
    addMessage(exchange.id, "dev", "Good catch. Should I use UTC?");
    addMessage(exchange.id, "critic", "Yes, use Date.now() instead of new Date().getTime() for consistency.");
    addMessage(exchange.id, "dev", "Fixed. Updated to UTC comparison.");

    // 4. Coordinator sees active exchange
    const active = listExchanges("active");
    expect(active).toHaveLength(1);
    const section = buildActiveExchangesSection(active);
    expect(section).toContain("5 messages");

    // 5. Complete exchange with summary
    const openedAt = new Date(exchange.openedAt);
    const result = completeExchange(
      exchange.id,
      "Fixed timezone bug in JWT expiry check. Using UTC comparison now.",
      new Date(openedAt.getTime() + 120000), // 2 minutes
    )!;

    expect(result.exchange.status).toBe("completed");
    expect(result.messageCount).toBe(5);
    expect(result.elapsedMs).toBe(120000);

    // 6. Coordinator notification
    const notification = buildCompletionNotification(result);
    expect(notification).toContain("dev ↔ critic");
    expect(notification).toContain("2m");
    expect(notification).toContain("timezone bug");

    // 7. No more active exchanges
    expect(listExchanges("active")).toHaveLength(0);
    expect(listExchanges("completed")).toHaveLength(1);

    // 8. Full event trail
    const events = getExchangeEvents(exchange.id);
    expect(events).toHaveLength(7); // opened + 5 messages + completed
    expect(events[0].type).toBe("exchange-opened");
    expect(events[6].type).toBe("exchange-completed");

    // 9. Can find by request ID
    const found = getExchangeByRequest("req-review-1");
    expect(found!.id).toBe(exchange.id);
  });

  it("open → timeout scenario", () => {
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review",
    });

    addMessage(exchange.id, "dev", "Hello?");
    // Critic never responds...

    timeoutExchanges(0);
    expect(getExchange(exchange.id)!.status).toBe("timed_out");
    expect(listExchanges("active")).toHaveLength(0);
  });

  it("open → cancel scenario", () => {
    const { exchange } = openExchange({
      agentRequestId: "req-1",
      requestingAgent: "dev",
      targetAgent: "critic",
      context: "Review",
    });

    cancelExchange(exchange.id, "Found the answer myself");
    expect(getExchange(exchange.id)!.status).toBe("cancelled");

    const events = getExchangeEvents(exchange.id);
    expect(events.some(e => e.type === "exchange-cancelled")).toBe(true);
  });
});
