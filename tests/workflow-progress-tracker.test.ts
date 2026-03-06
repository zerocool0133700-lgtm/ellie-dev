/**
 * Workflow Progress Tracker Tests — ELLIE-595
 *
 * Validates:
 *  - trackWorkflow() registers workflows with correct initial statuses
 *  - markStepDone() advances active step
 *  - markStepFailed() marks current step as failed
 *  - untrackWorkflow() removes workflows
 *  - listTrackedWorkflows() returns all active
 *  - formatStepLine() produces correct formatting per status
 *  - buildWorkflowSummary() produces human-readable summary
 *  - buildWorkflowProgressSection() builds/omits prompt section
 *  - getWorkflowProgressForPrompt() with test injection
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  trackWorkflow,
  markStepDone,
  markStepFailed,
  untrackWorkflow,
  getTrackedWorkflow,
  listTrackedWorkflows,
  formatStepLine,
  buildWorkflowSummary,
  buildWorkflowProgressSection,
  getWorkflowProgressForPrompt,
  _resetTrackerForTesting,
  _injectWorkflowsForTesting,
  type TrackedWorkflow,
} from "../src/workflow-progress-tracker.ts";
import type { WorkflowDefinition } from "../src/workflow-schema.ts";

beforeEach(() => {
  _resetTrackerForTesting();
  _injectWorkflowsForTesting(null);
});

// ── Helper ──────────────────────────────────────────────────────────────────

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    workflow_id: "wf-1",
    workflow_steps: [
      { agent: "critic", label: "Review code" },
      { agent: "dev", label: "Implement fix" },
      { agent: "research", label: "Verify solution" },
    ],
    current_step: 0,
    on_complete: "notify",
    ...overrides,
  };
}

// ── trackWorkflow ────────────────────────────────────────────────────────────

describe("trackWorkflow", () => {
  it("registers a workflow with correct initial statuses", () => {
    const tracked = trackWorkflow("ELLIE-100", makeWorkflow());
    expect(tracked.workItemId).toBe("ELLIE-100");
    expect(tracked.stepStatuses).toEqual(["active", "pending", "pending"]);
  });

  it("marks earlier steps as done when current_step > 0", () => {
    const tracked = trackWorkflow("ELLIE-100", makeWorkflow({ current_step: 1 }));
    expect(tracked.stepStatuses).toEqual(["done", "active", "pending"]);
  });

  it("marks all steps done except last when at last step", () => {
    const tracked = trackWorkflow("ELLIE-100", makeWorkflow({ current_step: 2 }));
    expect(tracked.stepStatuses).toEqual(["done", "done", "active"]);
  });

  it("is retrievable after tracking", () => {
    trackWorkflow("ELLIE-100", makeWorkflow());
    const found = getTrackedWorkflow("ELLIE-100");
    expect(found).not.toBeNull();
    expect(found!.workItemId).toBe("ELLIE-100");
  });

  it("overwrites existing workflow for same work item", () => {
    trackWorkflow("ELLIE-100", makeWorkflow());
    trackWorkflow("ELLIE-100", makeWorkflow({ current_step: 1 }));
    const found = getTrackedWorkflow("ELLIE-100");
    expect(found!.stepStatuses[0]).toBe("done");
  });
});

// ── markStepDone ─────────────────────────────────────────────────────────────

describe("markStepDone", () => {
  it("marks current step as done and advances", () => {
    trackWorkflow("ELLIE-100", makeWorkflow());
    const updated = markStepDone("ELLIE-100");
    expect(updated).not.toBeNull();
    expect(updated!.stepStatuses).toEqual(["done", "active", "pending"]);
    expect(updated!.workflow.current_step).toBe(1);
  });

  it("advances through all steps", () => {
    trackWorkflow("ELLIE-100", makeWorkflow());
    markStepDone("ELLIE-100");
    markStepDone("ELLIE-100");
    const final = markStepDone("ELLIE-100");
    expect(final!.stepStatuses).toEqual(["done", "done", "done"]);
  });

  it("returns null for unknown workflow", () => {
    expect(markStepDone("ELLIE-999")).toBeNull();
  });

  it("persists update in store", () => {
    trackWorkflow("ELLIE-100", makeWorkflow());
    markStepDone("ELLIE-100");
    const found = getTrackedWorkflow("ELLIE-100");
    expect(found!.workflow.current_step).toBe(1);
  });
});

// ── markStepFailed ───────────────────────────────────────────────────────────

describe("markStepFailed", () => {
  it("marks current step as failed", () => {
    trackWorkflow("ELLIE-100", makeWorkflow());
    const updated = markStepFailed("ELLIE-100");
    expect(updated).not.toBeNull();
    expect(updated!.stepStatuses).toEqual(["failed", "pending", "pending"]);
  });

  it("marks middle step as failed", () => {
    trackWorkflow("ELLIE-100", makeWorkflow({ current_step: 1 }));
    const updated = markStepFailed("ELLIE-100");
    expect(updated!.stepStatuses).toEqual(["done", "failed", "pending"]);
  });

  it("returns null for unknown workflow", () => {
    expect(markStepFailed("ELLIE-999")).toBeNull();
  });
});

// ── untrackWorkflow ──────────────────────────────────────────────────────────

describe("untrackWorkflow", () => {
  it("removes tracked workflow", () => {
    trackWorkflow("ELLIE-100", makeWorkflow());
    expect(untrackWorkflow("ELLIE-100")).toBe(true);
    expect(getTrackedWorkflow("ELLIE-100")).toBeNull();
  });

  it("returns false for unknown workflow", () => {
    expect(untrackWorkflow("ELLIE-999")).toBe(false);
  });
});

// ── listTrackedWorkflows ─────────────────────────────────────────────────────

describe("listTrackedWorkflows", () => {
  it("returns empty when no workflows", () => {
    expect(listTrackedWorkflows()).toHaveLength(0);
  });

  it("returns all tracked workflows", () => {
    trackWorkflow("ELLIE-100", makeWorkflow());
    trackWorkflow("ELLIE-200", makeWorkflow({ workflow_id: "wf-2" }));
    expect(listTrackedWorkflows()).toHaveLength(2);
  });
});

// ── formatStepLine ───────────────────────────────────────────────────────────

describe("formatStepLine", () => {
  it("formats done step", () => {
    const line = formatStepLine({ agent: "critic", label: "Review" }, 0, "done");
    expect(line).toContain("1.");
    expect(line).toContain("[done]");
    expect(line).toContain("critic: Review");
  });

  it("formats active step with bold", () => {
    const line = formatStepLine({ agent: "dev", label: "Fix" }, 1, "active");
    expect(line).toContain("2.");
    expect(line).toContain("**[active]**");
    expect(line).toContain("dev: Fix");
  });

  it("formats pending step", () => {
    const line = formatStepLine({ agent: "research", label: "Verify" }, 2, "pending");
    expect(line).toContain("3.");
    expect(line).toContain("[pending]");
  });

  it("formats failed step with bold", () => {
    const line = formatStepLine({ agent: "dev", label: "Implement" }, 0, "failed");
    expect(line).toContain("**[FAILED]**");
  });
});

// ── buildWorkflowSummary ─────────────────────────────────────────────────────

describe("buildWorkflowSummary", () => {
  it("shows active step for in-progress workflow", () => {
    const tracked = trackWorkflow("ELLIE-100", makeWorkflow());
    const summary = buildWorkflowSummary(tracked);
    expect(summary).toContain("wf-1");
    expect(summary).toContain("ELLIE-100");
    expect(summary).toContain("step 1/3");
    expect(summary).toContain("critic");
    expect(summary).toContain("in progress");
    expect(summary).toContain("Next: dev, research");
  });

  it("shows completed steps", () => {
    trackWorkflow("ELLIE-100", makeWorkflow());
    const tracked = markStepDone("ELLIE-100")!;
    const summary = buildWorkflowSummary(tracked);
    expect(summary).toContain("step 2/3");
    expect(summary).toContain("Completed: critic");
    expect(summary).toContain("Next: research");
  });

  it("shows failed step", () => {
    trackWorkflow("ELLIE-100", makeWorkflow());
    const tracked = markStepFailed("ELLIE-100")!;
    const summary = buildWorkflowSummary(tracked);
    expect(summary).toContain("Failed: critic");
  });

  it("shows all complete when workflow done", () => {
    trackWorkflow("ELLIE-100", makeWorkflow());
    markStepDone("ELLIE-100");
    markStepDone("ELLIE-100");
    const tracked = markStepDone("ELLIE-100")!;
    const summary = buildWorkflowSummary(tracked);
    expect(summary).toContain("all 3 steps complete");
    expect(summary).toContain("Completed: critic, dev, research");
  });
});

// ── buildWorkflowProgressSection ─────────────────────────────────────────────

describe("buildWorkflowProgressSection", () => {
  it("returns null for empty list", () => {
    expect(buildWorkflowProgressSection([])).toBeNull();
  });

  it("builds section with one workflow", () => {
    const tracked = trackWorkflow("ELLIE-100", makeWorkflow());
    const section = buildWorkflowProgressSection([tracked]);
    expect(section).not.toBeNull();
    expect(section).toContain("ACTIVE WORKFLOWS (1)");
    expect(section).toContain("wf-1");
    expect(section).toContain("[active]");
    expect(section).toContain("[pending]");
    expect(section).toContain("Track workflow progress");
  });

  it("builds section with multiple workflows", () => {
    const t1 = trackWorkflow("ELLIE-100", makeWorkflow());
    const t2 = trackWorkflow("ELLIE-200", makeWorkflow({ workflow_id: "wf-2" }));
    const section = buildWorkflowProgressSection([t1, t2]);
    expect(section).toContain("ACTIVE WORKFLOWS (2)");
    expect(section).toContain("wf-1");
    expect(section).toContain("wf-2");
  });

  it("includes step details for each workflow", () => {
    trackWorkflow("ELLIE-100", makeWorkflow());
    const tracked = markStepDone("ELLIE-100")!;
    const section = buildWorkflowProgressSection([tracked])!;
    expect(section).toContain("[done]");
    expect(section).toContain("[active]");
    expect(section).toContain("[pending]");
  });
});

// ── getWorkflowProgressForPrompt ─────────────────────────────────────────────

describe("getWorkflowProgressForPrompt", () => {
  it("returns null when no workflows tracked", () => {
    expect(getWorkflowProgressForPrompt()).toBeNull();
  });

  it("returns section when workflows are tracked", () => {
    trackWorkflow("ELLIE-100", makeWorkflow());
    const section = getWorkflowProgressForPrompt();
    expect(section).not.toBeNull();
    expect(section).toContain("ACTIVE WORKFLOWS");
  });

  it("uses test injection when provided", () => {
    const injected: TrackedWorkflow = {
      workItemId: "ELLIE-999",
      workflow: makeWorkflow({ workflow_id: "wf-injected" }),
      stepStatuses: ["done", "active", "pending"],
    };
    _injectWorkflowsForTesting([injected]);
    const section = getWorkflowProgressForPrompt();
    expect(section).toContain("wf-injected");
    expect(section).toContain("ELLIE-999");
  });

  it("returns null with empty test injection", () => {
    _injectWorkflowsForTesting([]);
    expect(getWorkflowProgressForPrompt()).toBeNull();
  });

  it("prefers test injection over store", () => {
    trackWorkflow("ELLIE-100", makeWorkflow());
    _injectWorkflowsForTesting([]);
    expect(getWorkflowProgressForPrompt()).toBeNull();
  });
});
