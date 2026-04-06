import { describe, it, expect } from "bun:test";
import { checkReadiness, formatReadinessResult, type ReadinessResult } from "../src/dispatch-readiness.ts";
import type { WorkItemDetails } from "../src/plane.ts";

/** Build a valid WorkItemDetails with sensible defaults, overridable per-test */
function makeDetails(overrides: Partial<WorkItemDetails> = {}): WorkItemDetails {
  return {
    id: "test-uuid",
    name: "Implement feature X",
    description: "A detailed description of the feature that is long enough to pass minimum length checks easily.",
    priority: "medium",
    state: "state-uuid",
    stateGroup: "started",
    sequenceId: 42,
    projectIdentifier: "ELLIE",
    estimatePoint: 3,
    assignees: ["user-1"],
    labels: ["label-1"],
    targetDate: "2027-01-01",
    startDate: "2026-04-01",
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: new Date().toISOString(),
    parent: null,
    ...overrides,
  };
}

// ============================================================
// BLOCKER RULES
// ============================================================

describe("dispatch-readiness blockers", () => {
  it("passes a well-formed ticket", () => {
    const result = checkReadiness(makeDetails());
    expect(result.ready).toBe(true);
    expect(result.blockers).toHaveLength(0);
  });

  it("blocks completed tickets", () => {
    const result = checkReadiness(makeDetails({ stateGroup: "completed" }));
    expect(result.ready).toBe(false);
    expect(result.blockers.some(b => b.rule === "state_terminal")).toBe(true);
  });

  it("blocks cancelled tickets", () => {
    const result = checkReadiness(makeDetails({ stateGroup: "cancelled" }));
    expect(result.ready).toBe(false);
    expect(result.blockers.some(b => b.rule === "state_terminal")).toBe(true);
  });

  it("blocks empty description", () => {
    const result = checkReadiness(makeDetails({ description: "" }));
    expect(result.ready).toBe(false);
    expect(result.blockers.some(b => b.rule === "description_empty")).toBe(true);
  });

  it("blocks whitespace-only description", () => {
    const result = checkReadiness(makeDetails({ description: "   " }));
    expect(result.ready).toBe(false);
    expect(result.blockers.some(b => b.rule === "description_empty")).toBe(true);
  });

  it("blocks description shorter than minimum", () => {
    const result = checkReadiness(makeDetails({ description: "Too short" }));
    expect(result.ready).toBe(false);
    expect(result.blockers.some(b => b.rule === "description_too_short")).toBe(true);
  });

  it("respects custom minDescriptionLength", () => {
    const result = checkReadiness(makeDetails({ description: "Short" }), { minDescriptionLength: 3 });
    expect(result.blockers.some(b => b.rule === "description_too_short")).toBe(false);
  });

  it("blocks description identical to title", () => {
    const result = checkReadiness(makeDetails({
      name: "Fix the bug",
      description: "Fix the bug",
    }));
    expect(result.ready).toBe(false);
    expect(result.blockers.some(b => b.rule === "description_matches_title")).toBe(true);
  });

  it("blocks case-insensitive title match", () => {
    const result = checkReadiness(makeDetails({
      name: "Fix The Bug",
      description: "fix the bug",
    }));
    expect(result.ready).toBe(false);
    expect(result.blockers.some(b => b.rule === "description_matches_title")).toBe(true);
  });

  it("blocks urgent priority without estimate", () => {
    const result = checkReadiness(makeDetails({ priority: "urgent", estimatePoint: null }));
    expect(result.ready).toBe(false);
    expect(result.blockers.some(b => b.rule === "high_priority_no_estimate")).toBe(true);
  });

  it("blocks high priority without estimate", () => {
    const result = checkReadiness(makeDetails({ priority: "high", estimatePoint: null }));
    expect(result.ready).toBe(false);
    expect(result.blockers.some(b => b.rule === "high_priority_no_estimate")).toBe(true);
  });

  it("allows high priority with estimate", () => {
    const result = checkReadiness(makeDetails({ priority: "high", estimatePoint: 5 }));
    expect(result.blockers.some(b => b.rule === "high_priority_no_estimate")).toBe(false);
  });

  it("allows medium priority without estimate (warning only)", () => {
    const result = checkReadiness(makeDetails({ priority: "medium", estimatePoint: null }));
    expect(result.blockers.some(b => b.rule === "high_priority_no_estimate")).toBe(false);
    expect(result.warnings.some(w => w.rule === "no_estimate")).toBe(true);
  });
});

// ============================================================
// WARNING RULES
// ============================================================

describe("dispatch-readiness warnings", () => {
  it("warns on no estimate", () => {
    const result = checkReadiness(makeDetails({ priority: "low", estimatePoint: null }));
    expect(result.ready).toBe(true);
    expect(result.warnings.some(w => w.rule === "no_estimate")).toBe(true);
  });

  it("warns on no assignee", () => {
    const result = checkReadiness(makeDetails({ assignees: [] }));
    expect(result.ready).toBe(true);
    expect(result.warnings.some(w => w.rule === "no_assignee")).toBe(true);
  });

  it("warns on past target date", () => {
    const result = checkReadiness(makeDetails({ targetDate: "2020-01-01" }));
    expect(result.ready).toBe(true);
    expect(result.warnings.some(w => w.rule === "target_date_past")).toBe(true);
  });

  it("no warning for future target date", () => {
    const result = checkReadiness(makeDetails({ targetDate: "2030-12-31" }));
    expect(result.warnings.some(w => w.rule === "target_date_past")).toBe(false);
  });

  it("no warning for null target date", () => {
    const result = checkReadiness(makeDetails({ targetDate: null }));
    expect(result.warnings.some(w => w.rule === "target_date_past")).toBe(false);
  });

  it("warns on stale ticket (>30 days since update)", () => {
    const staleDate = new Date();
    staleDate.setDate(staleDate.getDate() - 45);
    const result = checkReadiness(makeDetails({ updatedAt: staleDate.toISOString() }));
    expect(result.ready).toBe(true);
    expect(result.warnings.some(w => w.rule === "stale_ticket")).toBe(true);
  });

  it("no stale warning for recently updated ticket", () => {
    const result = checkReadiness(makeDetails({ updatedAt: new Date().toISOString() }));
    expect(result.warnings.some(w => w.rule === "stale_ticket")).toBe(false);
  });

  it("respects custom staleDaysThreshold", () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 10);
    const result = checkReadiness(makeDetails({ updatedAt: oldDate.toISOString() }), { staleDaysThreshold: 7 });
    expect(result.warnings.some(w => w.rule === "stale_ticket")).toBe(true);
  });
});

// ============================================================
// STRICT MODE
// ============================================================

describe("dispatch-readiness strict mode", () => {
  it("promotes warnings to blockers in strict mode", () => {
    const result = checkReadiness(
      makeDetails({ priority: "low", estimatePoint: null, assignees: [] }),
      { strictMode: true },
    );
    expect(result.ready).toBe(false);
    expect(result.blockers.some(b => b.rule === "no_estimate")).toBe(true);
    expect(result.blockers.some(b => b.rule === "no_assignee")).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("does not promote in non-strict mode", () => {
    const result = checkReadiness(
      makeDetails({ priority: "low", estimatePoint: null, assignees: [] }),
      { strictMode: false },
    );
    expect(result.ready).toBe(true);
    expect(result.warnings.some(w => w.rule === "no_estimate")).toBe(true);
    expect(result.warnings.some(w => w.rule === "no_assignee")).toBe(true);
  });
});

// ============================================================
// FORMAT
// ============================================================

describe("formatReadinessResult", () => {
  it("formats clean result", () => {
    const result: ReadinessResult = { ready: true, blockers: [], warnings: [] };
    expect(formatReadinessResult(result, "ELLIE-42")).toBe("ELLIE-42: all readiness checks passed");
  });

  it("formats blockers", () => {
    const result: ReadinessResult = {
      ready: false,
      blockers: [{ rule: "description_empty", message: "Ticket has no description" }],
      warnings: [],
    };
    const text = formatReadinessResult(result, "ELLIE-42");
    expect(text).toContain("BLOCKED");
    expect(text).toContain("[BLOCKER]");
    expect(text).toContain("no description");
  });

  it("formats warnings", () => {
    const result: ReadinessResult = {
      ready: true,
      blockers: [],
      warnings: [{ rule: "no_estimate", message: "No estimate point set" }],
    };
    const text = formatReadinessResult(result, "ELLIE-42");
    expect(text).toContain("[WARNING]");
    expect(text).toContain("No estimate");
  });
});
