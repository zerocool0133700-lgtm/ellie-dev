/**
 * Dispatch Commitment Tracker Tests — ELLIE-589
 *
 * Validates:
 *  - trackDispatchStart() creates pending dispatch commitments
 *  - trackDispatchComplete() resolves commitments
 *  - trackDispatchFailure() marks commitments as timed_out
 *  - listDispatchCommitments() filters by source
 *  - Integration with commitment ledger lifecycle
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  trackDispatchStart,
  trackDispatchComplete,
  trackDispatchFailure,
  listDispatchCommitments,
} from "../src/dispatch-commitment-tracker.ts";
import {
  _resetLedgerForTesting,
  createCommitment,
  listCommitments,
  pendingCount,
} from "../src/commitment-ledger.ts";

beforeEach(() => {
  _resetLedgerForTesting();
});

// ── trackDispatchStart ──────────────────────────────────────────────────────

describe("trackDispatchStart", () => {
  it("creates a pending dispatch commitment", () => {
    const result = trackDispatchStart("sess-1", "dev", "ELLIE-100", "Fix the bug", 0);

    expect(result.commitmentId).toBeDefined();
    expect(result.commitment.status).toBe("pending");
    expect(result.commitment.source).toBe("dispatch");
    expect(result.commitment.sessionId).toBe("sess-1");
    expect(result.commitment.turnCreated).toBe(0);
  });

  it("includes agent name and work item in description", () => {
    const result = trackDispatchStart("sess-1", "dev", "ELLIE-200", "Implement feature", 0);

    expect(result.commitment.description).toContain("dev");
    expect(result.commitment.description).toContain("ELLIE-200");
    expect(result.commitment.description).toContain("Implement feature");
  });

  it("handles missing work item ID", () => {
    const result = trackDispatchStart("sess-1", "research", undefined, "Look into X", 0);

    expect(result.commitment.description).toContain("research");
    expect(result.commitment.description).toContain("Look into X");
    expect(result.commitment.description).not.toContain("undefined");
  });

  it("increments pending count for the session", () => {
    expect(pendingCount("sess-1")).toBe(0);

    trackDispatchStart("sess-1", "dev", "ELLIE-100", "Task 1", 0);
    expect(pendingCount("sess-1")).toBe(1);

    trackDispatchStart("sess-1", "research", "ELLIE-101", "Task 2", 1);
    expect(pendingCount("sess-1")).toBe(2);
  });

  it("isolates commitments by session", () => {
    trackDispatchStart("sess-a", "dev", "ELLIE-100", "Task A", 0);
    trackDispatchStart("sess-b", "dev", "ELLIE-101", "Task B", 0);

    expect(pendingCount("sess-a")).toBe(1);
    expect(pendingCount("sess-b")).toBe(1);
  });
});

// ── trackDispatchComplete ───────────────────────────────────────────────────

describe("trackDispatchComplete", () => {
  it("resolves a pending dispatch commitment", () => {
    const { commitmentId } = trackDispatchStart("sess-1", "dev", "ELLIE-100", "Fix bug", 0);

    const resolved = trackDispatchComplete("sess-1", commitmentId, 1);

    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("resolved");
    expect(resolved!.turnResolved).toBe(1);
    expect(resolved!.resolvedAt).toBeDefined();
  });

  it("decrements pending count after resolution", () => {
    const { commitmentId } = trackDispatchStart("sess-1", "dev", "ELLIE-100", "Fix bug", 0);
    expect(pendingCount("sess-1")).toBe(1);

    trackDispatchComplete("sess-1", commitmentId, 1);
    expect(pendingCount("sess-1")).toBe(0);
  });

  it("returns null for non-existent commitment", () => {
    const resolved = trackDispatchComplete("sess-1", "non-existent-id", 1);
    expect(resolved).toBeNull();
  });

  it("returns null for already-resolved commitment", () => {
    const { commitmentId } = trackDispatchStart("sess-1", "dev", "ELLIE-100", "Fix bug", 0);

    trackDispatchComplete("sess-1", commitmentId, 1);
    const second = trackDispatchComplete("sess-1", commitmentId, 2);

    expect(second).toBeNull();
  });

  it("returns null for wrong session", () => {
    const { commitmentId } = trackDispatchStart("sess-1", "dev", "ELLIE-100", "Fix bug", 0);

    const resolved = trackDispatchComplete("sess-other", commitmentId, 1);
    expect(resolved).toBeNull();
  });
});

// ── trackDispatchFailure ────────────────────────────────────────────────────

describe("trackDispatchFailure", () => {
  it("marks a pending dispatch commitment as timed_out", () => {
    const { commitmentId } = trackDispatchStart("sess-1", "dev", "ELLIE-100", "Fix bug", 0);

    const failed = trackDispatchFailure("sess-1", commitmentId);

    expect(failed).not.toBeNull();
    expect(failed!.status).toBe("timed_out");
  });

  it("decrements pending count after failure", () => {
    const { commitmentId } = trackDispatchStart("sess-1", "dev", "ELLIE-100", "Fix bug", 0);
    expect(pendingCount("sess-1")).toBe(1);

    trackDispatchFailure("sess-1", commitmentId);
    expect(pendingCount("sess-1")).toBe(0);
  });

  it("returns null for non-existent commitment", () => {
    const failed = trackDispatchFailure("sess-1", "non-existent-id");
    expect(failed).toBeNull();
  });

  it("returns null for already-resolved commitment", () => {
    const { commitmentId } = trackDispatchStart("sess-1", "dev", "ELLIE-100", "Fix bug", 0);
    trackDispatchComplete("sess-1", commitmentId, 1);

    const failed = trackDispatchFailure("sess-1", commitmentId);
    expect(failed).toBeNull();
  });

  it("returns null for already-timed-out commitment", () => {
    const { commitmentId } = trackDispatchStart("sess-1", "dev", "ELLIE-100", "Fix bug", 0);
    trackDispatchFailure("sess-1", commitmentId);

    const second = trackDispatchFailure("sess-1", commitmentId);
    expect(second).toBeNull();
  });
});

// ── listDispatchCommitments ─────────────────────────────────────────────────

describe("listDispatchCommitments", () => {
  it("returns only dispatch-source commitments", () => {
    trackDispatchStart("sess-1", "dev", "ELLIE-100", "Task 1", 0);
    trackDispatchStart("sess-1", "research", "ELLIE-101", "Task 2", 1);

    // Add a conversational commitment directly
    createCommitment({
      sessionId: "sess-1",
      description: "I'll check that for you",
      source: "conversational",
      turnCreated: 2,
    });

    const dispatches = listDispatchCommitments("sess-1");
    expect(dispatches).toHaveLength(2);
    expect(dispatches.every(c => c.source === "dispatch")).toBe(true);

    // Total should be 3 (2 dispatch + 1 conversational)
    expect(listCommitments("sess-1")).toHaveLength(3);
  });

  it("returns empty array for session with no dispatches", () => {
    const dispatches = listDispatchCommitments("no-such-session");
    expect(dispatches).toHaveLength(0);
  });

  it("includes all states of dispatch commitments", () => {
    const { commitmentId: id1 } = trackDispatchStart("sess-1", "dev", "ELLIE-100", "Task 1", 0);
    const { commitmentId: id2 } = trackDispatchStart("sess-1", "dev", "ELLIE-101", "Task 2", 1);
    trackDispatchStart("sess-1", "dev", "ELLIE-102", "Task 3", 2);

    trackDispatchComplete("sess-1", id1, 3);
    trackDispatchFailure("sess-1", id2);

    const dispatches = listDispatchCommitments("sess-1");
    expect(dispatches).toHaveLength(3);

    const statuses = dispatches.map(c => c.status).sort();
    expect(statuses).toEqual(["pending", "resolved", "timed_out"]);
  });
});

// ── Full lifecycle ──────────────────────────────────────────────────────────

describe("dispatch commitment lifecycle", () => {
  it("tracks start → complete lifecycle", () => {
    const { commitmentId } = trackDispatchStart("sess-1", "dev", "ELLIE-100", "Fix auth bug", 0);
    expect(pendingCount("sess-1")).toBe(1);

    const resolved = trackDispatchComplete("sess-1", commitmentId, 1);
    expect(resolved!.status).toBe("resolved");
    expect(pendingCount("sess-1")).toBe(0);
  });

  it("tracks start → failure lifecycle", () => {
    const { commitmentId } = trackDispatchStart("sess-1", "dev", "ELLIE-100", "Fix auth bug", 0);
    expect(pendingCount("sess-1")).toBe(1);

    const failed = trackDispatchFailure("sess-1", commitmentId);
    expect(failed!.status).toBe("timed_out");
    expect(pendingCount("sess-1")).toBe(0);
  });

  it("handles multiple concurrent dispatches", () => {
    const d1 = trackDispatchStart("sess-1", "dev", "ELLIE-100", "Task 1", 0);
    const d2 = trackDispatchStart("sess-1", "research", "ELLIE-101", "Task 2", 0);
    const d3 = trackDispatchStart("sess-1", "strategy", "ELLIE-102", "Task 3", 0);

    expect(pendingCount("sess-1")).toBe(3);

    trackDispatchComplete("sess-1", d1.commitmentId, 1);
    expect(pendingCount("sess-1")).toBe(2);

    trackDispatchFailure("sess-1", d2.commitmentId);
    expect(pendingCount("sess-1")).toBe(1);

    trackDispatchComplete("sess-1", d3.commitmentId, 2);
    expect(pendingCount("sess-1")).toBe(0);
  });
});
