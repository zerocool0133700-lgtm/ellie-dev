/**
 * Sub-Commitment Tracking Tests — ELLIE-598
 *
 * Validates:
 *  - createSubCommitment() creates nested commitments under a parent
 *  - Sub-commitments inherit workItemId from parent
 *  - listSubCommitments() returns children for a given parent
 *  - isSubCommitment() correctly identifies nested commitments
 *  - listTopLevelCommitments() excludes sub-commitments
 *  - getCommitmentTree() returns parent + children
 *  - Sub-commitments can be resolved/timed out independently
 *  - Prompt section shows sub-commitments indented under parent
 *  - formatSubCommitmentLine() formatting
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  createCommitment,
  createSubCommitment,
  resolveCommitment,
  listCommitments,
  listSubCommitments,
  listTopLevelCommitments,
  isSubCommitment,
  getCommitmentTree,
  getCommitment,
  timeoutStaleCommitments,
  _resetLedgerForTesting,
  type Commitment,
} from "../src/commitment-ledger.ts";
import {
  formatSubCommitmentLine,
  buildPendingCommitmentsSection,
  _injectPendingCommitmentsForTesting,
} from "../src/pending-commitments-prompt.ts";

beforeEach(() => {
  _resetLedgerForTesting();
  _injectPendingCommitmentsForTesting(null);
});

// ── Helper ──────────────────────────────────────────────────────────────────

function makeParent(sessionId = "s"): Commitment {
  return createCommitment({
    sessionId,
    description: "Implement auth module",
    source: "dispatch",
    turnCreated: 1,
    workItemId: "ELLIE-100",
  });
}

// ── createSubCommitment ─────────────────────────────────────────────────────

describe("createSubCommitment", () => {
  it("creates a sub-commitment under a parent", () => {
    const parent = makeParent();
    const sub = createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Review auth implementation",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 3,
    });

    expect(sub).not.toBeNull();
    expect(sub!.parentCommitmentId).toBe(parent.id);
    expect(sub!.requestingAgent).toBe("dev");
    expect(sub!.targetAgent).toBe("critic");
    expect(sub!.status).toBe("pending");
    expect(sub!.source).toBe("dispatch");
  });

  it("inherits workItemId from parent", () => {
    const parent = makeParent();
    const sub = createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Sub-task",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    });

    expect(sub!.workItemId).toBe("ELLIE-100");
  });

  it("stores estimatedDuration when provided", () => {
    const parent = makeParent();
    const sub = createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Quick review",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
      estimatedDuration: 15,
    });

    expect(sub!.estimatedDuration).toBe(15);
  });

  it("returns null if parent does not exist", () => {
    const sub = createSubCommitment({
      sessionId: "s",
      parentCommitmentId: "nonexistent",
      description: "Orphan",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    });

    expect(sub).toBeNull();
  });

  it("returns null if parent is in wrong session", () => {
    const parent = makeParent("s1");
    const sub = createSubCommitment({
      sessionId: "s2",
      parentCommitmentId: parent.id,
      description: "Wrong session",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    });

    expect(sub).toBeNull();
  });

  it("is stored in the session ledger", () => {
    const parent = makeParent();
    createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Sub",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    });

    // Parent + sub = 2 commitments
    expect(listCommitments("s")).toHaveLength(2);
  });

  it("assigns unique ID different from parent", () => {
    const parent = makeParent();
    const sub = createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Sub",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    });

    expect(sub!.id).not.toBe(parent.id);
  });
});

// ── listSubCommitments ──────────────────────────────────────────────────────

describe("listSubCommitments", () => {
  it("returns sub-commitments for a parent", () => {
    const parent = makeParent();
    createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Sub A",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    });
    createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Sub B",
      requestingAgent: "dev",
      targetAgent: "security",
      turnCreated: 3,
    });

    const subs = listSubCommitments("s", parent.id);
    expect(subs).toHaveLength(2);
  });

  it("filters by status", () => {
    const parent = makeParent();
    const sub1 = createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Sub A",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    })!;
    createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Sub B",
      requestingAgent: "dev",
      targetAgent: "security",
      turnCreated: 3,
    });

    resolveCommitment("s", sub1.id, 5);

    expect(listSubCommitments("s", parent.id, "pending")).toHaveLength(1);
    expect(listSubCommitments("s", parent.id, "resolved")).toHaveLength(1);
  });

  it("returns empty for parent with no subs", () => {
    const parent = makeParent();
    expect(listSubCommitments("s", parent.id)).toHaveLength(0);
  });

  it("does not mix sub-commitments between parents", () => {
    const parent1 = makeParent();
    const parent2 = createCommitment({
      sessionId: "s",
      description: "Second task",
      source: "dispatch",
      turnCreated: 1,
    });

    createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent1.id,
      description: "Sub for P1",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    });
    createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent2.id,
      description: "Sub for P2",
      requestingAgent: "dev",
      targetAgent: "ops",
      turnCreated: 2,
    });

    expect(listSubCommitments("s", parent1.id)).toHaveLength(1);
    expect(listSubCommitments("s", parent1.id)[0].description).toBe("Sub for P1");
    expect(listSubCommitments("s", parent2.id)).toHaveLength(1);
    expect(listSubCommitments("s", parent2.id)[0].description).toBe("Sub for P2");
  });
});

// ── isSubCommitment ─────────────────────────────────────────────────────────

describe("isSubCommitment", () => {
  it("returns true for sub-commitment", () => {
    const parent = makeParent();
    const sub = createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Sub",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    })!;

    expect(isSubCommitment(sub)).toBe(true);
  });

  it("returns false for top-level commitment", () => {
    const parent = makeParent();
    expect(isSubCommitment(parent)).toBe(false);
  });
});

// ── listTopLevelCommitments ─────────────────────────────────────────────────

describe("listTopLevelCommitments", () => {
  it("excludes sub-commitments", () => {
    const parent = makeParent();
    createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Sub",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    });

    const topLevel = listTopLevelCommitments("s");
    expect(topLevel).toHaveLength(1);
    expect(topLevel[0].id).toBe(parent.id);
  });

  it("filters by status", () => {
    const parent1 = makeParent();
    createCommitment({
      sessionId: "s",
      description: "Another",
      source: "dispatch",
      turnCreated: 2,
    });
    resolveCommitment("s", parent1.id, 5);

    expect(listTopLevelCommitments("s", "pending")).toHaveLength(1);
    expect(listTopLevelCommitments("s", "resolved")).toHaveLength(1);
  });

  it("returns empty for unknown session", () => {
    expect(listTopLevelCommitments("nonexistent")).toHaveLength(0);
  });
});

// ── getCommitmentTree ────────────────────────────────────────────────────────

describe("getCommitmentTree", () => {
  it("returns parent with children", () => {
    const parent = makeParent();
    createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Sub A",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    });
    createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Sub B",
      requestingAgent: "dev",
      targetAgent: "security",
      turnCreated: 3,
    });

    const tree = getCommitmentTree("s", parent.id);
    expect(tree).not.toBeNull();
    expect(tree!.commitment.id).toBe(parent.id);
    expect(tree!.children).toHaveLength(2);
  });

  it("returns empty children for leaf commitment", () => {
    const parent = makeParent();
    const tree = getCommitmentTree("s", parent.id);
    expect(tree!.children).toHaveLength(0);
  });

  it("returns null for unknown commitment", () => {
    expect(getCommitmentTree("s", "fake")).toBeNull();
  });
});

// ── Sub-commitment resolve/timeout ──────────────────────────────────────────

describe("sub-commitment resolve", () => {
  it("resolves a sub-commitment independently", () => {
    const parent = makeParent();
    const sub = createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Sub",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    })!;

    const resolved = resolveCommitment("s", sub.id, 5);
    expect(resolved).not.toBeNull();
    expect(resolved!.status).toBe("resolved");

    // Parent still pending
    const parentNow = getCommitment("s", parent.id);
    expect(parentNow!.status).toBe("pending");
  });

  it("resolves parent without affecting sub-commitments", () => {
    const parent = makeParent();
    const sub = createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Sub",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    })!;

    resolveCommitment("s", parent.id, 5);

    const subNow = getCommitment("s", sub.id);
    expect(subNow!.status).toBe("pending");
  });
});

describe("sub-commitment timeout", () => {
  it("times out stale sub-commitments", () => {
    const parent = makeParent();
    createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Stale sub",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    });

    // Timeout everything (threshold 0ms)
    const flagged = timeoutStaleCommitments("s", 0);
    expect(flagged).toBe(2); // parent + sub
  });

  it("times out sub-commitments independently of parent", () => {
    const parent = makeParent();
    createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Sub",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    });

    // Resolve parent first
    resolveCommitment("s", parent.id, 3);

    // Timeout — only sub should be flagged
    const flagged = timeoutStaleCommitments("s", 0);
    expect(flagged).toBe(1);
  });
});

// ── workItemId inheritance ──────────────────────────────────────────────────

describe("workItemId inheritance", () => {
  it("inherits from parent with workItemId", () => {
    const parent = makeParent(); // has workItemId: "ELLIE-100"
    const sub = createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Sub",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    })!;

    expect(sub.workItemId).toBe("ELLIE-100");
  });

  it("inherits undefined when parent has no workItemId", () => {
    const parent = createCommitment({
      sessionId: "s",
      description: "No work item",
      source: "conversational",
      turnCreated: 1,
    });
    const sub = createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Sub",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    })!;

    expect(sub.workItemId).toBeUndefined();
  });
});

// ── formatSubCommitmentLine ─────────────────────────────────────────────────

describe("formatSubCommitmentLine", () => {
  it("formats with agent arrow and indentation", () => {
    const parent = makeParent();
    const sub = createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Review code",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    })!;

    const line = formatSubCommitmentLine(sub, 3);
    expect(line).toMatch(/^\s{2}-/); // 2-space indent
    expect(line).toContain("→critic");
    expect(line).toContain("Review code");
    expect(line).toContain("1 turn ago");
  });

  it("includes estimated duration when present", () => {
    const parent = makeParent();
    const sub = createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Audit",
      requestingAgent: "dev",
      targetAgent: "security",
      turnCreated: 2,
      estimatedDuration: 30,
    })!;

    const line = formatSubCommitmentLine(sub, 3);
    expect(line).toContain("~30m");
  });

  it("omits duration when not present", () => {
    const parent = makeParent();
    const sub = createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Review",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    })!;

    const line = formatSubCommitmentLine(sub, 3);
    expect(line).not.toContain("~");
  });

  it("formats escalated sub-commitment bold", () => {
    const parent = makeParent();
    const sub = createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Stale sub",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 0,
    })!;

    const line = formatSubCommitmentLine(sub, 5, 3); // 5 turns ago, threshold 3
    expect(line).toContain("**");
  });

  it("formats critical sub-commitment with OVERDUE", () => {
    const parent = makeParent();
    const sub = createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Very stale",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 0,
    })!;

    const line = formatSubCommitmentLine(sub, 10, 3); // 10 turns ago, threshold 3 → critical (>=6)
    expect(line).toContain("[OVERDUE]");
  });
});

// ── buildPendingCommitmentsSection with sub-commitments ─────────────────────

describe("buildPendingCommitmentsSection with sub-commitments", () => {
  it("shows sub-commitments indented under parent", () => {
    const parent = makeParent();
    const sub = createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Review auth",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    })!;

    const all = listCommitments("s");
    const section = buildPendingCommitmentsSection(all, 3);
    expect(section).not.toBeNull();
    expect(section).toContain("PENDING COMMITMENTS (2)");
    expect(section).toContain("Implement auth module");
    expect(section).toContain("→critic");
    expect(section).toContain("Review auth");

    // Sub-commitment should appear after parent
    const parentIdx = section!.indexOf("Implement auth module");
    const subIdx = section!.indexOf("→critic");
    expect(subIdx).toBeGreaterThan(parentIdx);
  });

  it("counts sub-commitments in total pending count", () => {
    const parent = makeParent();
    createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Sub A",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    });
    createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Sub B",
      requestingAgent: "dev",
      targetAgent: "security",
      turnCreated: 3,
    });

    const all = listCommitments("s");
    const section = buildPendingCommitmentsSection(all, 4);
    expect(section).toContain("PENDING COMMITMENTS (3)");
  });

  it("shows orphaned sub-commitments when parent is resolved", () => {
    const parent = makeParent();
    createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Orphaned sub",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    });
    resolveCommitment("s", parent.id, 3);

    const all = listCommitments("s");
    const section = buildPendingCommitmentsSection(all, 4);
    expect(section).not.toBeNull();
    expect(section).toContain("PENDING COMMITMENTS (1)");
    expect(section).toContain("Orphaned sub");
  });

  it("returns null when all commitments (including subs) are resolved", () => {
    const parent = makeParent();
    const sub = createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Sub",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 2,
    })!;

    resolveCommitment("s", parent.id, 3);
    resolveCommitment("s", sub.id, 4);

    const all = listCommitments("s");
    const section = buildPendingCommitmentsSection(all, 5);
    expect(section).toBeNull();
  });

  it("includes critical sub-commitments in escalation count", () => {
    const parent = makeParent();
    createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Very old sub",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 0,
    });

    const all = listCommitments("s");
    const section = buildPendingCommitmentsSection(all, 10, 3); // sub is 10 turns old
    expect(section).toContain("unresolved commitment");
  });
});

// ── Full scenario: parent with multiple sub-commitments ─────────────────────

describe("full sub-commitment scenario", () => {
  it("creates, tracks, and resolves sub-commitments within a parent", () => {
    // Parent: dev implementing auth
    const parent = createCommitment({
      sessionId: "s",
      description: "Implement auth module",
      source: "dispatch",
      turnCreated: 1,
      workItemId: "ELLIE-100",
    });

    // Dev asks critic for code review
    const review = createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Code review on auth module",
      requestingAgent: "dev",
      targetAgent: "critic",
      turnCreated: 3,
      estimatedDuration: 15,
    })!;

    // Dev asks security for audit
    const audit = createSubCommitment({
      sessionId: "s",
      parentCommitmentId: parent.id,
      description: "Security audit on auth module",
      requestingAgent: "dev",
      targetAgent: "security",
      turnCreated: 3,
      estimatedDuration: 30,
    })!;

    // Both inherit workItemId
    expect(review.workItemId).toBe("ELLIE-100");
    expect(audit.workItemId).toBe("ELLIE-100");

    // Tree view shows 2 children
    const tree = getCommitmentTree("s", parent.id)!;
    expect(tree.children).toHaveLength(2);

    // Critic completes review
    resolveCommitment("s", review.id, 5);
    expect(listSubCommitments("s", parent.id, "pending")).toHaveLength(1);
    expect(listSubCommitments("s", parent.id, "resolved")).toHaveLength(1);

    // Security completes audit
    resolveCommitment("s", audit.id, 7);
    expect(listSubCommitments("s", parent.id, "pending")).toHaveLength(0);

    // Prompt section at this point shows only parent
    const all = listCommitments("s");
    const section = buildPendingCommitmentsSection(all, 8);
    expect(section).toContain("PENDING COMMITMENTS (1)");
    expect(section).toContain("Implement auth module");

    // Resolve parent
    resolveCommitment("s", parent.id, 8);
    const finalSection = buildPendingCommitmentsSection(listCommitments("s"), 9);
    expect(finalSection).toBeNull();
  });
});
