/**
 * Workflow Conditional Router Tests — ELLIE-596
 *
 * Validates:
 *  - detectOutcome() parses success/failure signals from agent output
 *  - resolveTarget() resolves step targets (index, "next", "done")
 *  - resolveConditionalRoute() routes based on outcome + step config
 *  - Loopback guard detects and limits infinite loops
 *  - applyRoute() produces updated workflow definition
 *  - Default behavior (no on_success/on_failure) is sequential
 */

import { describe, it, expect } from "bun:test";
import {
  detectOutcome,
  resolveTarget,
  resolveConditionalRoute,
  applyRoute,
  createIterationCounts,
  incrementIteration,
  DEFAULT_MAX_ITERATIONS,
} from "../src/workflow-conditional-router.ts";
import type { WorkflowDefinition } from "../src/workflow-schema.ts";

// ── Helper ──────────────────────────────────────────────────────────────────

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    workflow_id: "wf-1",
    workflow_steps: [
      { agent: "dev", label: "Implement" },
      { agent: "critic", label: "Review", on_success: "next", on_failure: 0 },
      { agent: "ops", label: "Deploy" },
    ],
    current_step: 0,
    on_complete: "notify",
    ...overrides,
  };
}

// ── detectOutcome ────────────────────────────────────────────────────────────

describe("detectOutcome", () => {
  it("detects 'approved' as success", () => {
    expect(detectOutcome("Code reviewed and approved. Looks clean.")).toBe("success");
  });

  it("detects 'ship it' as success", () => {
    expect(detectOutcome("Ship it — ready for production.")).toBe("success");
  });

  it("detects 'looks good' as success", () => {
    expect(detectOutcome("Looks good to me.")).toBe("success");
  });

  it("detects 'passed' as success", () => {
    expect(detectOutcome("All checks passed.")).toBe("success");
  });

  it("detects 'tests pass' as success", () => {
    expect(detectOutcome("All tests passing.")).toBe("success");
  });

  it("detects 'rejected' as failure", () => {
    expect(detectOutcome("Changes rejected — too many issues.")).toBe("failure");
  });

  it("detects 'needs work' as failure", () => {
    expect(detectOutcome("This needs more work on the error handling.")).toBe("failure");
  });

  it("detects 'rework' as failure", () => {
    expect(detectOutcome("Sending back for rework.")).toBe("failure");
  });

  it("detects 'failed' as failure", () => {
    expect(detectOutcome("Build failed with 3 errors.")).toBe("failure");
  });

  it("detects 'critical issues' as failure", () => {
    expect(detectOutcome("Found critical issues in the auth module.")).toBe("failure");
  });

  it("detects 'send it back' as failure", () => {
    expect(detectOutcome("Send it back to dev for fixes.")).toBe("failure");
  });

  it("detects 'not ready' as failure", () => {
    expect(detectOutcome("Not ready for deployment yet.")).toBe("failure");
  });

  it("defaults to success for neutral text", () => {
    expect(detectOutcome("Here's my analysis of the codebase.")).toBe("success");
  });

  it("failure takes priority over success when both present", () => {
    expect(detectOutcome("Tests passed but critical issues found. Needs work.")).toBe("failure");
  });
});

// ── resolveTarget ────────────────────────────────────────────────────────────

describe("resolveTarget", () => {
  it("resolves 'next' to next sequential step", () => {
    expect(resolveTarget("next", 0, 3)).toBe(1);
  });

  it("resolves undefined to next sequential step", () => {
    expect(resolveTarget(undefined, 1, 3)).toBe(2);
  });

  it("resolves 'next' at last step to 'done'", () => {
    expect(resolveTarget("next", 2, 3)).toBe("done");
  });

  it("resolves 'done' to 'done'", () => {
    expect(resolveTarget("done", 0, 3)).toBe("done");
  });

  it("resolves numeric index", () => {
    expect(resolveTarget(0, 1, 3)).toBe(0);
  });

  it("resolves out-of-bounds index to 'done'", () => {
    expect(resolveTarget(5, 0, 3)).toBe("done");
  });

  it("resolves negative index to 'done'", () => {
    expect(resolveTarget(-1, 0, 3)).toBe("done");
  });
});

// ── resolveConditionalRoute — success path ───────────────────────────────────

describe("resolveConditionalRoute — success", () => {
  it("routes to next step on success with default config", () => {
    const wf = makeWorkflow();
    const result = resolveConditionalRoute(wf, "success");
    expect(result.outcome).toBe("success");
    expect(result.targetStep).toBe(1);
    expect(result.loopDetected).toBe(false);
  });

  it("routes to explicit on_success target", () => {
    const wf = makeWorkflow({ current_step: 1 }); // critic step: on_success = "next"
    const result = resolveConditionalRoute(wf, "success");
    expect(result.targetStep).toBe(2);
    expect(result.targetAgent).toBe("ops");
  });

  it("routes to 'done' when success at last step", () => {
    const wf = makeWorkflow({ current_step: 2 });
    const result = resolveConditionalRoute(wf, "success");
    expect(result.targetStep).toBe("done");
  });
});

// ── resolveConditionalRoute — failure path ───────────────────────────────────

describe("resolveConditionalRoute — failure", () => {
  it("routes to on_failure target (loopback)", () => {
    const wf = makeWorkflow({ current_step: 1 }); // critic step: on_failure = 0 (back to dev)
    const result = resolveConditionalRoute(wf, "failure");
    expect(result.outcome).toBe("failure");
    expect(result.targetStep).toBe(0);
    expect(result.targetAgent).toBe("dev");
    expect(result.targetLabel).toBe("Implement");
  });

  it("routes to next step on failure with no on_failure config", () => {
    const wf = makeWorkflow(); // dev step: no on_failure defined
    const result = resolveConditionalRoute(wf, "failure");
    expect(result.targetStep).toBe(1); // defaults to next
  });

  it("routes to 'done' with on_failure = 'done'", () => {
    const wf = makeWorkflow({
      workflow_steps: [
        { agent: "dev", label: "Implement", on_failure: "done" },
        { agent: "ops", label: "Deploy" },
      ],
      current_step: 0,
    });
    const result = resolveConditionalRoute(wf, "failure");
    expect(result.targetStep).toBe("done");
  });
});

// ── Loopback guard ───────────────────────────────────────────────────────────

describe("loopback guard", () => {
  it("does not trigger on first visit", () => {
    const wf = makeWorkflow({ current_step: 1 });
    const result = resolveConditionalRoute(wf, "failure");
    expect(result.loopDetected).toBe(false);
    expect(result.iterationCount).toBe(1);
  });

  it("tracks iteration count", () => {
    const wf = makeWorkflow({ current_step: 1 });
    const counts = createIterationCounts();
    incrementIteration(counts, 0);
    incrementIteration(counts, 0);
    const result = resolveConditionalRoute(wf, "failure", counts);
    expect(result.iterationCount).toBe(3);
    expect(result.loopDetected).toBe(false);
  });

  it("triggers at max iterations", () => {
    const wf = makeWorkflow({ current_step: 1 });
    const counts = createIterationCounts();
    for (let i = 0; i < DEFAULT_MAX_ITERATIONS - 1; i++) {
      incrementIteration(counts, 0);
    }
    const result = resolveConditionalRoute(wf, "failure", counts);
    expect(result.loopDetected).toBe(true);
    expect(result.iterationCount).toBe(DEFAULT_MAX_ITERATIONS);
  });

  it("respects custom max iterations", () => {
    const wf = makeWorkflow({ current_step: 1 });
    const counts = createIterationCounts();
    incrementIteration(counts, 0);
    const result = resolveConditionalRoute(wf, "failure", counts, 2);
    expect(result.loopDetected).toBe(true);
    expect(result.iterationCount).toBe(2);
  });

  it("does not trigger for 'done' target", () => {
    const wf = makeWorkflow({ current_step: 2 }); // last step
    const counts = createIterationCounts();
    for (let i = 0; i < 10; i++) incrementIteration(counts, 0);
    const result = resolveConditionalRoute(wf, "success", counts);
    expect(result.targetStep).toBe("done");
    expect(result.loopDetected).toBe(false);
  });
});

// ── applyRoute ───────────────────────────────────────────────────────────────

describe("applyRoute", () => {
  it("returns updated workflow with new current_step", () => {
    const wf = makeWorkflow();
    const route = resolveConditionalRoute(wf, "success");
    const updated = applyRoute(wf, route, "Step output");
    expect(updated).not.toBeNull();
    expect(updated!.current_step).toBe(1);
    expect(updated!.step_context).toBe("Step output");
  });

  it("returns null when route leads to 'done'", () => {
    const wf = makeWorkflow({ current_step: 2 });
    const route = resolveConditionalRoute(wf, "success");
    expect(applyRoute(wf, route)).toBeNull();
  });

  it("applies loopback route", () => {
    const wf = makeWorkflow({ current_step: 1 });
    const route = resolveConditionalRoute(wf, "failure"); // back to step 0
    const updated = applyRoute(wf, route, "Rejected: needs fixes");
    expect(updated).not.toBeNull();
    expect(updated!.current_step).toBe(0);
    expect(updated!.step_context).toBe("Rejected: needs fixes");
  });

  it("preserves workflow fields", () => {
    const wf = makeWorkflow();
    const route = resolveConditionalRoute(wf, "success");
    const updated = applyRoute(wf, route)!;
    expect(updated.workflow_id).toBe("wf-1");
    expect(updated.on_complete).toBe("notify");
    expect(updated.workflow_steps).toHaveLength(3);
  });

  it("preserves existing context when no new context provided", () => {
    const wf = makeWorkflow({ step_context: "old context" });
    const route = resolveConditionalRoute(wf, "success");
    const updated = applyRoute(wf, route)!;
    expect(updated.step_context).toBe("old context");
  });

  it("does not mutate original workflow", () => {
    const wf = makeWorkflow();
    const route = resolveConditionalRoute(wf, "success");
    applyRoute(wf, route, "new context");
    expect(wf.current_step).toBe(0);
    expect(wf.step_context).toBeUndefined();
  });
});

// ── iteration count helpers ──────────────────────────────────────────────────

describe("iteration count helpers", () => {
  it("creates empty map", () => {
    const counts = createIterationCounts();
    expect(counts.size).toBe(0);
  });

  it("increments from 0", () => {
    const counts = createIterationCounts();
    incrementIteration(counts, 0);
    expect(counts.get(0)).toBe(1);
  });

  it("increments existing count", () => {
    const counts = createIterationCounts();
    incrementIteration(counts, 0);
    incrementIteration(counts, 0);
    expect(counts.get(0)).toBe(2);
  });

  it("tracks multiple steps independently", () => {
    const counts = createIterationCounts();
    incrementIteration(counts, 0);
    incrementIteration(counts, 0);
    incrementIteration(counts, 1);
    expect(counts.get(0)).toBe(2);
    expect(counts.get(1)).toBe(1);
  });
});

// ── Full scenario: dev → critic → dev (loopback) → critic → ops ─────────────

describe("full loopback scenario", () => {
  it("routes through critic rejection and re-approval", () => {
    const wf = makeWorkflow();
    const counts = createIterationCounts();

    // Step 0: dev implements
    const r1 = resolveConditionalRoute(wf, "success", counts);
    expect(r1.targetStep).toBe(1); // → critic
    const wf2 = applyRoute(wf, r1, "Implementation done")!;
    incrementIteration(counts, r1.targetStep as number);

    // Step 1: critic rejects
    const r2 = resolveConditionalRoute(wf2, "failure", counts);
    expect(r2.targetStep).toBe(0); // → back to dev
    expect(r2.loopDetected).toBe(false);
    const wf3 = applyRoute(wf2, r2, "Needs more error handling")!;
    incrementIteration(counts, r2.targetStep as number);

    // Step 0: dev re-implements
    const r3 = resolveConditionalRoute(wf3, "success", counts);
    expect(r3.targetStep).toBe(1); // → critic again
    const wf4 = applyRoute(wf3, r3, "Added error handling")!;
    incrementIteration(counts, r3.targetStep as number);

    // Step 1: critic approves
    const r4 = resolveConditionalRoute(wf4, "success", counts);
    expect(r4.targetStep).toBe(2); // → ops
    expect(r4.targetAgent).toBe("ops");
    const wf5 = applyRoute(wf4, r4, "Approved")!;

    // Step 2: ops completes
    const r5 = resolveConditionalRoute(wf5, "success", counts);
    expect(r5.targetStep).toBe("done");
  });
});
