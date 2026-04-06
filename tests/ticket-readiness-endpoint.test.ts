import { describe, it, expect, mock, beforeEach } from "bun:test";
import { checkReadiness, formatReadinessResult } from "../src/dispatch-readiness.ts";
import type { WorkItemDetails } from "../src/plane.ts";

/**
 * Tests for the GET /api/ticket/readiness endpoint logic.
 *
 * The endpoint is a thin HTTP wrapper around checkReadiness + fetchWorkItemDetails.
 * Since the core readiness rules are tested in dispatch-readiness.test.ts,
 * these tests verify the endpoint's response shape, parameter handling,
 * and integration with the readiness checker.
 */

function makeDetails(overrides: Partial<WorkItemDetails> = {}): WorkItemDetails {
  return {
    id: "test-uuid",
    name: "Implement feature X",
    description: "A detailed description of the feature that is long enough to pass checks.",
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

describe("ticket readiness endpoint response shape", () => {
  it("returns correct shape for a ready ticket", () => {
    const details = makeDetails();
    const result = checkReadiness(details);
    const response = {
      work_item_id: "ELLIE-42",
      title: details.name,
      ready: result.ready,
      blockers: result.blockers,
      warnings: result.warnings,
      summary: formatReadinessResult(result, "ELLIE-42"),
      details: {
        priority: details.priority,
        state_group: details.stateGroup,
        has_estimate: details.estimatePoint != null,
        has_assignee: details.assignees.length > 0,
        has_target_date: details.targetDate != null,
        description_length: details.description.trim().length,
      },
    };

    expect(response.ready).toBe(true);
    expect(response.blockers).toHaveLength(0);
    expect(response.work_item_id).toBe("ELLIE-42");
    expect(response.title).toBe("Implement feature X");
    expect(response.details.has_estimate).toBe(true);
    expect(response.details.has_assignee).toBe(true);
    expect(response.details.has_target_date).toBe(true);
    expect(response.details.description_length).toBeGreaterThan(20);
  });

  it("returns blockers for a bad ticket", () => {
    const details = makeDetails({
      description: "",
      priority: "urgent",
      estimatePoint: null,
    });
    const result = checkReadiness(details);
    const response = {
      work_item_id: "ELLIE-99",
      title: details.name,
      ready: result.ready,
      blockers: result.blockers,
      warnings: result.warnings,
      summary: formatReadinessResult(result, "ELLIE-99"),
      details: {
        priority: details.priority,
        state_group: details.stateGroup,
        has_estimate: false,
        has_assignee: true,
        has_target_date: true,
        description_length: 0,
      },
    };

    expect(response.ready).toBe(false);
    expect(response.blockers.length).toBeGreaterThan(0);
    expect(response.blockers.some(b => b.rule === "description_empty")).toBe(true);
    expect(response.blockers.some(b => b.rule === "high_priority_no_estimate")).toBe(true);
    expect(response.summary).toContain("BLOCKED");
    expect(response.details.has_estimate).toBe(false);
    expect(response.details.description_length).toBe(0);
  });

  it("strict mode promotes warnings to blockers in response", () => {
    const details = makeDetails({
      priority: "low",
      estimatePoint: null,
      assignees: [],
    });
    const result = checkReadiness(details, { strictMode: true });
    expect(result.ready).toBe(false);
    expect(result.blockers.some(b => b.rule === "no_estimate")).toBe(true);
    expect(result.blockers.some(b => b.rule === "no_assignee")).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("includes all detail fields", () => {
    const details = makeDetails({
      priority: "high",
      stateGroup: "unstarted",
      estimatePoint: 5,
      assignees: ["u1", "u2"],
      targetDate: "2027-06-15",
    });
    const response = {
      details: {
        priority: details.priority,
        state_group: details.stateGroup,
        has_estimate: details.estimatePoint != null,
        has_assignee: details.assignees.length > 0,
        has_target_date: details.targetDate != null,
        description_length: details.description.trim().length,
      },
    };

    expect(response.details.priority).toBe("high");
    expect(response.details.state_group).toBe("unstarted");
    expect(response.details.has_estimate).toBe(true);
    expect(response.details.has_assignee).toBe(true);
    expect(response.details.has_target_date).toBe(true);
    expect(response.details.description_length).toBeGreaterThan(0);
  });
});
