/**
 * Pending Commitments Prompt Tests — ELLIE-590 + ELLIE-591
 *
 * Validates:
 *  - formatCommitmentLine() formats individual commitment lines
 *  - buildPendingCommitmentsSection() builds/omits section correctly
 *  - getPendingCommitmentsForPrompt() integrates with cache and ledger
 *  - Section is omitted when no pending commitments exist
 *  - Turn count displays correctly
 *  - ELLIE-591: Escalation tiers (normal, escalated, critical)
 *  - ELLIE-591: Sorting escalated to top, critical instruction
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  formatCommitmentLine,
  buildPendingCommitmentsSection,
  getPendingCommitmentsForPrompt,
  setPendingCommitmentsContext,
  _injectPendingCommitmentsForTesting,
  getEscalationTier,
} from "../src/pending-commitments-prompt.ts";
import {
  _resetLedgerForTesting,
  createCommitment,
  resolveCommitment,
  type Commitment,
} from "../src/commitment-ledger.ts";

beforeEach(() => {
  _resetLedgerForTesting();
  _injectPendingCommitmentsForTesting(null);
});

// ── Helper ──────────────────────────────────────────────────────────────────

function makeCommitment(overrides: Partial<Commitment> = {}): Commitment {
  return {
    id: "test-id",
    sessionId: "sess-1",
    description: "Dispatch to dev for ELLIE-100: Fix auth bug",
    source: "dispatch",
    status: "pending",
    createdAt: new Date().toISOString(),
    turnCreated: 0,
    ...overrides,
  };
}

// ── formatCommitmentLine ────────────────────────────────────────────────────

describe("formatCommitmentLine", () => {
  it("shows 'this turn' when created on the current turn", () => {
    const c = makeCommitment({ turnCreated: 5 });
    const line = formatCommitmentLine(c, 5);
    expect(line).toContain("this turn");
    expect(line).toContain("[dispatch]");
    expect(line).toContain("Fix auth bug");
  });

  it("shows '1 turn ago' for singular", () => {
    const c = makeCommitment({ turnCreated: 3 });
    const line = formatCommitmentLine(c, 4);
    expect(line).toContain("1 turn ago");
  });

  it("shows 'N turns ago' for plural", () => {
    const c = makeCommitment({ turnCreated: 0 });
    const line = formatCommitmentLine(c, 7);
    expect(line).toContain("7 turns ago");
  });

  it("includes source tag and description", () => {
    const c = makeCommitment({ source: "conversational", description: "I'll look into that" });
    const line = formatCommitmentLine(c, 0);
    expect(line).toContain("[conversational]");
    expect(line).toContain("I'll look into that");
  });

  it("starts with dash for markdown list formatting", () => {
    const c = makeCommitment();
    const line = formatCommitmentLine(c, 0);
    expect(line.startsWith("- ")).toBe(true);
  });
});

// ── buildPendingCommitmentsSection ──────────────────────────────────────────

describe("buildPendingCommitmentsSection", () => {
  it("returns null when no commitments", () => {
    const result = buildPendingCommitmentsSection([], 0);
    expect(result).toBeNull();
  });

  it("returns null when all commitments are resolved", () => {
    const commitments = [
      makeCommitment({ status: "resolved" }),
      makeCommitment({ status: "timed_out" }),
    ];
    const result = buildPendingCommitmentsSection(commitments, 0);
    expect(result).toBeNull();
  });

  it("builds section with pending commitments only", () => {
    const commitments = [
      makeCommitment({ id: "1", status: "pending", description: "Task A" }),
      makeCommitment({ id: "2", status: "resolved", description: "Task B" }),
      makeCommitment({ id: "3", status: "pending", description: "Task C" }),
    ];
    const result = buildPendingCommitmentsSection(commitments, 0);

    expect(result).not.toBeNull();
    expect(result).toContain("PENDING COMMITMENTS (2)");
    expect(result).toContain("Task A");
    expect(result).not.toContain("Task B");
    expect(result).toContain("Task C");
  });

  it("includes count in header", () => {
    const commitments = [
      makeCommitment({ id: "1", status: "pending" }),
    ];
    const result = buildPendingCommitmentsSection(commitments, 0);
    expect(result).toContain("PENDING COMMITMENTS (1)");
  });

  it("includes tracking instruction", () => {
    const commitments = [makeCommitment({ status: "pending" })];
    const result = buildPendingCommitmentsSection(commitments, 0);
    expect(result).toContain("Track their progress");
  });

  it("shows correct turn ages for multiple commitments", () => {
    const commitments = [
      makeCommitment({ id: "1", status: "pending", turnCreated: 0, description: "Old task" }),
      makeCommitment({ id: "2", status: "pending", turnCreated: 4, description: "Recent task" }),
    ];
    const result = buildPendingCommitmentsSection(commitments, 5)!;
    expect(result).toContain("5 turns ago");
    expect(result).toContain("1 turn ago");
  });
});

// ── getPendingCommitmentsForPrompt ──────────────────────────────────────────

describe("getPendingCommitmentsForPrompt", () => {
  it("returns null when no session is set", () => {
    const result = getPendingCommitmentsForPrompt();
    expect(result).toBeNull();
  });

  it("returns null when session has no commitments", () => {
    setPendingCommitmentsContext("empty-session", 0);
    const result = getPendingCommitmentsForPrompt();
    expect(result).toBeNull();
  });

  it("returns section when session has pending commitments", () => {
    createCommitment({
      sessionId: "sess-1",
      description: "Dispatch to dev: fix bug",
      source: "dispatch",
      turnCreated: 0,
    });

    setPendingCommitmentsContext("sess-1", 1);
    const result = getPendingCommitmentsForPrompt();

    expect(result).not.toBeNull();
    expect(result).toContain("PENDING COMMITMENTS");
    expect(result).toContain("fix bug");
    expect(result).toContain("1 turn ago");
  });

  it("excludes resolved commitments from the section", () => {
    const c = createCommitment({
      sessionId: "sess-1",
      description: "Task that was done",
      source: "dispatch",
      turnCreated: 0,
    });
    resolveCommitment("sess-1", c.id, 1);

    setPendingCommitmentsContext("sess-1", 2);
    const result = getPendingCommitmentsForPrompt();
    expect(result).toBeNull();
  });

  it("uses test injection when provided", () => {
    _injectPendingCommitmentsForTesting([
      makeCommitment({ status: "pending", description: "Injected task" }),
    ]);

    setPendingCommitmentsContext("any-session", 3);
    const result = getPendingCommitmentsForPrompt();

    expect(result).not.toBeNull();
    expect(result).toContain("Injected task");
    expect(result).toContain("3 turns ago");
  });

  it("test injection with empty array returns null", () => {
    _injectPendingCommitmentsForTesting([]);
    setPendingCommitmentsContext("any-session", 0);
    const result = getPendingCommitmentsForPrompt();
    expect(result).toBeNull();
  });

  it("shows multiple pending commitments from ledger", () => {
    createCommitment({
      sessionId: "sess-2",
      description: "First dispatch",
      source: "dispatch",
      turnCreated: 0,
    });
    createCommitment({
      sessionId: "sess-2",
      description: "Second dispatch",
      source: "dispatch",
      turnCreated: 1,
    });

    setPendingCommitmentsContext("sess-2", 3);
    const result = getPendingCommitmentsForPrompt();

    expect(result).toContain("PENDING COMMITMENTS (2)");
    expect(result).toContain("First dispatch");
    expect(result).toContain("Second dispatch");
    expect(result).toContain("3 turns ago");
    expect(result).toContain("2 turns ago");
  });
});

// ── getEscalationTier (ELLIE-591) ───────────────────────────────────────────

describe("getEscalationTier", () => {
  it("returns 'normal' for turns below threshold", () => {
    expect(getEscalationTier(0)).toBe("normal");
    expect(getEscalationTier(1)).toBe("normal");
    expect(getEscalationTier(2)).toBe("normal");
  });

  it("returns 'escalated' at threshold", () => {
    expect(getEscalationTier(3)).toBe("escalated");
  });

  it("returns 'escalated' between threshold and 2x threshold", () => {
    expect(getEscalationTier(4)).toBe("escalated");
    expect(getEscalationTier(5)).toBe("escalated");
  });

  it("returns 'critical' at 2x threshold", () => {
    expect(getEscalationTier(6)).toBe("critical");
  });

  it("returns 'critical' above 2x threshold", () => {
    expect(getEscalationTier(10)).toBe("critical");
  });

  it("respects custom threshold", () => {
    expect(getEscalationTier(1, 2)).toBe("normal");
    expect(getEscalationTier(2, 2)).toBe("escalated");
    expect(getEscalationTier(3, 2)).toBe("escalated");
    expect(getEscalationTier(4, 2)).toBe("critical");
  });
});

// ── formatCommitmentLine escalation (ELLIE-591) ─────────────────────────────

describe("formatCommitmentLine — escalation", () => {
  it("normal commitment has no bold or prefix", () => {
    const c = makeCommitment({ turnCreated: 0 });
    const line = formatCommitmentLine(c, 1);
    expect(line).not.toContain("**");
    expect(line).not.toContain("[OVERDUE]");
  });

  it("escalated commitment is bolded", () => {
    const c = makeCommitment({ turnCreated: 0 });
    const line = formatCommitmentLine(c, 3); // 3 turns ago = escalated with default threshold
    expect(line).toContain("**");
    expect(line).not.toContain("[OVERDUE]");
  });

  it("critical commitment has OVERDUE prefix and bold", () => {
    const c = makeCommitment({ turnCreated: 0 });
    const line = formatCommitmentLine(c, 6); // 6 turns ago = critical with default threshold
    expect(line).toContain("**[OVERDUE]**");
    expect(line).toContain("**[dispatch]");
  });

  it("uses custom threshold for escalation", () => {
    const c = makeCommitment({ turnCreated: 0 });
    // With threshold 2: 2 turns = escalated, 4 turns = critical
    expect(formatCommitmentLine(c, 1, 2)).not.toContain("**");
    expect(formatCommitmentLine(c, 2, 2)).toContain("**");
    expect(formatCommitmentLine(c, 4, 2)).toContain("[OVERDUE]");
  });
});

// ── buildPendingCommitmentsSection escalation (ELLIE-591) ───────────────────

describe("buildPendingCommitmentsSection — escalation", () => {
  it("sorts escalated commitments before normal ones", () => {
    const commitments = [
      makeCommitment({ id: "1", status: "pending", turnCreated: 2, description: "Recent" }),
      makeCommitment({ id: "2", status: "pending", turnCreated: 0, description: "Old" }),
    ];
    const result = buildPendingCommitmentsSection(commitments, 3)!;
    // "Old" is 3 turns ago (escalated), "Recent" is 1 turn ago (normal)
    const oldIdx = result.indexOf("Old");
    const recentIdx = result.indexOf("Recent");
    expect(oldIdx).toBeLessThan(recentIdx);
  });

  it("sorts critical before escalated before normal", () => {
    const commitments = [
      makeCommitment({ id: "1", status: "pending", turnCreated: 6, description: "Normal" }),
      makeCommitment({ id: "2", status: "pending", turnCreated: 0, description: "Critical" }),
      makeCommitment({ id: "3", status: "pending", turnCreated: 3, description: "Escalated" }),
    ];
    const result = buildPendingCommitmentsSection(commitments, 6)!;
    const criticalIdx = result.indexOf("Critical");
    const escalatedIdx = result.indexOf("Escalated");
    const normalIdx = result.indexOf("Normal");
    expect(criticalIdx).toBeLessThan(escalatedIdx);
    expect(escalatedIdx).toBeLessThan(normalIdx);
  });

  it("adds explicit instruction for critical commitments", () => {
    const commitments = [
      makeCommitment({ id: "1", status: "pending", turnCreated: 0, description: "Old task" }),
    ];
    const result = buildPendingCommitmentsSection(commitments, 6)!;
    expect(result).toContain("unresolved commitment");
    expect(result).toContain("6 turns old");
    expect(result).toContain("Address it before continuing");
  });

  it("uses plural for multiple critical commitments", () => {
    const commitments = [
      makeCommitment({ id: "1", status: "pending", turnCreated: 0, description: "Task A" }),
      makeCommitment({ id: "2", status: "pending", turnCreated: 0, description: "Task B" }),
    ];
    const result = buildPendingCommitmentsSection(commitments, 6)!;
    expect(result).toContain("2 unresolved commitments");
    expect(result).toContain("Address them before continuing");
  });

  it("no explicit instruction when no critical commitments", () => {
    const commitments = [
      makeCommitment({ id: "1", status: "pending", turnCreated: 2 }),
    ];
    const result = buildPendingCommitmentsSection(commitments, 3)!;
    expect(result).not.toContain("Address");
    expect(result).not.toContain("before continuing");
  });

  it("respects custom threshold for escalation", () => {
    const commitments = [
      makeCommitment({ id: "1", status: "pending", turnCreated: 0, description: "Task" }),
    ];
    // With threshold 2: turn 4 = critical (2*2)
    const result = buildPendingCommitmentsSection(commitments, 4, 2)!;
    expect(result).toContain("[OVERDUE]");
    expect(result).toContain("Address it before continuing");
  });

  it("only escalated (not critical) does not generate instruction", () => {
    const commitments = [
      makeCommitment({ id: "1", status: "pending", turnCreated: 0, description: "Task" }),
    ];
    // With default threshold 3: turn 3 = escalated, turn 5 = still escalated
    const result = buildPendingCommitmentsSection(commitments, 5)!;
    expect(result).toContain("**");
    expect(result).not.toContain("Address");
  });
});
