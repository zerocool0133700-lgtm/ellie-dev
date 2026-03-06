/**
 * Commitment Ledger Tests — ELLIE-588
 *
 * Validates:
 *  - Create commitment with all required fields
 *  - Resolve commitment transitions status correctly
 *  - List commitments with optional status filter
 *  - Get single commitment by ID
 *  - Timeout stale commitments after threshold
 *  - Session isolation — commitments scoped per session
 *  - Clear session removes all commitments
 *  - Pending count helper
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  createCommitment,
  resolveCommitment,
  listCommitments,
  getCommitment,
  timeoutStaleCommitments,
  clearSession,
  pendingCount,
  _resetLedgerForTesting,
  type Commitment,
} from "../src/commitment-ledger.ts";

beforeEach(() => {
  _resetLedgerForTesting();
});

// ── createCommitment ────────────────────────────────────────────────────────

describe("createCommitment", () => {
  it("creates a commitment with all required fields", () => {
    const c = createCommitment({
      sessionId: "sess-1",
      description: "Will fix the auth bug",
      source: "conversational",
      turnCreated: 5,
    });

    expect(c.id).toBeTruthy();
    expect(c.sessionId).toBe("sess-1");
    expect(c.description).toBe("Will fix the auth bug");
    expect(c.source).toBe("conversational");
    expect(c.status).toBe("pending");
    expect(c.turnCreated).toBe(5);
    expect(c.createdAt).toBeTruthy();
    expect(c.resolvedAt).toBeUndefined();
    expect(c.turnResolved).toBeUndefined();
  });

  it("assigns unique IDs to each commitment", () => {
    const c1 = createCommitment({ sessionId: "s", description: "a", source: "dispatch", turnCreated: 1 });
    const c2 = createCommitment({ sessionId: "s", description: "b", source: "dispatch", turnCreated: 2 });
    expect(c1.id).not.toBe(c2.id);
  });

  it("supports dispatch source", () => {
    const c = createCommitment({ sessionId: "s", description: "task", source: "dispatch", turnCreated: 0 });
    expect(c.source).toBe("dispatch");
  });

  it("stores commitment in session-scoped ledger", () => {
    createCommitment({ sessionId: "sess-1", description: "task", source: "dispatch", turnCreated: 1 });
    const list = listCommitments("sess-1");
    expect(list.length).toBe(1);
  });
});

// ── resolveCommitment ───────────────────────────────────────────────────────

describe("resolveCommitment", () => {
  it("resolves a pending commitment", () => {
    const c = createCommitment({ sessionId: "s", description: "task", source: "dispatch", turnCreated: 1 });
    const resolved = resolveCommitment("s", c.id, 10);

    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("resolved");
    expect(resolved!.turnResolved).toBe(10);
    expect(resolved!.resolvedAt).toBeTruthy();
  });

  it("returns null for non-existent commitment", () => {
    const result = resolveCommitment("s", "fake-id", 5);
    expect(result).toBeNull();
  });

  it("returns null for non-existent session", () => {
    const result = resolveCommitment("nonexistent", "fake-id", 5);
    expect(result).toBeNull();
  });

  it("returns null for already-resolved commitment", () => {
    const c = createCommitment({ sessionId: "s", description: "task", source: "dispatch", turnCreated: 1 });
    resolveCommitment("s", c.id, 5);
    const secondResolve = resolveCommitment("s", c.id, 10);
    expect(secondResolve).toBeNull();
  });

  it("returns null for timed-out commitment", () => {
    const c = createCommitment({ sessionId: "s", description: "task", source: "dispatch", turnCreated: 1 });
    // Force timeout
    timeoutStaleCommitments("s", 0);
    const result = resolveCommitment("s", c.id, 10);
    expect(result).toBeNull();
  });
});

// ── listCommitments ─────────────────────────────────────────────────────────

describe("listCommitments", () => {
  it("lists all commitments for a session", () => {
    createCommitment({ sessionId: "s", description: "a", source: "dispatch", turnCreated: 1 });
    createCommitment({ sessionId: "s", description: "b", source: "conversational", turnCreated: 2 });
    expect(listCommitments("s").length).toBe(2);
  });

  it("filters by status", () => {
    const c1 = createCommitment({ sessionId: "s", description: "a", source: "dispatch", turnCreated: 1 });
    createCommitment({ sessionId: "s", description: "b", source: "dispatch", turnCreated: 2 });
    resolveCommitment("s", c1.id, 5);

    expect(listCommitments("s", "pending").length).toBe(1);
    expect(listCommitments("s", "resolved").length).toBe(1);
    expect(listCommitments("s", "timed_out").length).toBe(0);
  });

  it("returns empty array for unknown session", () => {
    expect(listCommitments("nonexistent")).toEqual([]);
  });

  it("returns a copy (mutations don't affect ledger)", () => {
    createCommitment({ sessionId: "s", description: "a", source: "dispatch", turnCreated: 1 });
    const list = listCommitments("s");
    list.pop();
    expect(listCommitments("s").length).toBe(1);
  });
});

// ── getCommitment ───────────────────────────────────────────────────────────

describe("getCommitment", () => {
  it("retrieves a commitment by ID", () => {
    const c = createCommitment({ sessionId: "s", description: "task", source: "dispatch", turnCreated: 1 });
    const found = getCommitment("s", c.id);
    expect(found).not.toBeNull();
    expect(found!.description).toBe("task");
  });

  it("returns null for unknown ID", () => {
    expect(getCommitment("s", "fake")).toBeNull();
  });

  it("returns null for wrong session", () => {
    const c = createCommitment({ sessionId: "s1", description: "task", source: "dispatch", turnCreated: 1 });
    expect(getCommitment("s2", c.id)).toBeNull();
  });
});

// ── timeoutStaleCommitments ─────────────────────────────────────────────────

describe("timeoutStaleCommitments", () => {
  it("flags stale pending commitments as timed_out", () => {
    createCommitment({ sessionId: "s", description: "old task", source: "dispatch", turnCreated: 1 });

    // Use threshold of 0ms so everything is stale
    const flagged = timeoutStaleCommitments("s", 0);
    expect(flagged).toBe(1);

    const list = listCommitments("s", "timed_out");
    expect(list.length).toBe(1);
    expect(list[0].description).toBe("old task");
  });

  it("does not flag recent commitments", () => {
    createCommitment({ sessionId: "s", description: "fresh task", source: "dispatch", turnCreated: 1 });

    // Use a large threshold
    const flagged = timeoutStaleCommitments("s", 60 * 60 * 1000);
    expect(flagged).toBe(0);
  });

  it("does not flag already-resolved commitments", () => {
    const c = createCommitment({ sessionId: "s", description: "done task", source: "dispatch", turnCreated: 1 });
    resolveCommitment("s", c.id, 5);

    const flagged = timeoutStaleCommitments("s", 0);
    expect(flagged).toBe(0);
  });

  it("returns 0 for unknown session", () => {
    expect(timeoutStaleCommitments("nonexistent")).toBe(0);
  });

  it("uses custom now parameter for testability", () => {
    createCommitment({ sessionId: "s", description: "task", source: "dispatch", turnCreated: 1 });

    // Use a "now" that is 1 hour in the future, threshold 30 min
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const flagged = timeoutStaleCommitments("s", 30 * 60 * 1000, future);
    expect(flagged).toBe(1);
  });

  it("flags multiple stale commitments at once", () => {
    createCommitment({ sessionId: "s", description: "a", source: "dispatch", turnCreated: 1 });
    createCommitment({ sessionId: "s", description: "b", source: "dispatch", turnCreated: 2 });
    createCommitment({ sessionId: "s", description: "c", source: "dispatch", turnCreated: 3 });

    const flagged = timeoutStaleCommitments("s", 0);
    expect(flagged).toBe(3);
  });
});

// ── Session isolation ───────────────────────────────────────────────────────

describe("session isolation", () => {
  it("commitments are scoped per session", () => {
    createCommitment({ sessionId: "s1", description: "task A", source: "dispatch", turnCreated: 1 });
    createCommitment({ sessionId: "s2", description: "task B", source: "dispatch", turnCreated: 1 });

    expect(listCommitments("s1").length).toBe(1);
    expect(listCommitments("s2").length).toBe(1);
    expect(listCommitments("s1")[0].description).toBe("task A");
    expect(listCommitments("s2")[0].description).toBe("task B");
  });

  it("resolving in one session does not affect another", () => {
    const c1 = createCommitment({ sessionId: "s1", description: "a", source: "dispatch", turnCreated: 1 });
    createCommitment({ sessionId: "s2", description: "b", source: "dispatch", turnCreated: 1 });

    resolveCommitment("s1", c1.id, 5);

    expect(listCommitments("s1", "resolved").length).toBe(1);
    expect(listCommitments("s2", "pending").length).toBe(1);
  });
});

// ── clearSession ────────────────────────────────────────────────────────────

describe("clearSession", () => {
  it("removes all commitments for a session", () => {
    createCommitment({ sessionId: "s", description: "a", source: "dispatch", turnCreated: 1 });
    createCommitment({ sessionId: "s", description: "b", source: "dispatch", turnCreated: 2 });

    clearSession("s");
    expect(listCommitments("s")).toEqual([]);
  });

  it("does not affect other sessions", () => {
    createCommitment({ sessionId: "s1", description: "a", source: "dispatch", turnCreated: 1 });
    createCommitment({ sessionId: "s2", description: "b", source: "dispatch", turnCreated: 1 });

    clearSession("s1");
    expect(listCommitments("s1")).toEqual([]);
    expect(listCommitments("s2").length).toBe(1);
  });

  it("is safe to call on unknown session", () => {
    clearSession("nonexistent"); // Should not throw
  });
});

// ── pendingCount ────────────────────────────────────────────────────────────

describe("pendingCount", () => {
  it("counts only pending commitments", () => {
    const c1 = createCommitment({ sessionId: "s", description: "a", source: "dispatch", turnCreated: 1 });
    createCommitment({ sessionId: "s", description: "b", source: "dispatch", turnCreated: 2 });
    createCommitment({ sessionId: "s", description: "c", source: "dispatch", turnCreated: 3 });

    resolveCommitment("s", c1.id, 5);
    expect(pendingCount("s")).toBe(2);
  });

  it("returns 0 for unknown session", () => {
    expect(pendingCount("nonexistent")).toBe(0);
  });

  it("returns 0 when all resolved", () => {
    const c = createCommitment({ sessionId: "s", description: "a", source: "dispatch", turnCreated: 1 });
    resolveCommitment("s", c.id, 5);
    expect(pendingCount("s")).toBe(0);
  });
});
