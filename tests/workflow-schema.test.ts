/**
 * Workflow Schema Tests — ELLIE-593
 *
 * Validates:
 *  - validateStep() rejects invalid steps
 *  - validateWorkflowInput() validates full workflow definitions
 *  - validateWorkflowInput() passes through when no workflow fields present
 *  - getCurrentStep() / advanceStep() / isWorkflowComplete() navigation
 *  - getRemainingSteps() / getCompletedSteps() helpers
 *  - Defaults: current_step=0, on_complete="notify"
 */

import { describe, it, expect } from "bun:test";
import {
  validateStep,
  validateWorkflowInput,
  getCurrentStep,
  advanceStep,
  isWorkflowComplete,
  getRemainingSteps,
  getCompletedSteps,
  type WorkflowDefinition,
  type WorkflowInput,
} from "../src/workflow-schema.ts";

// ── Helper ──────────────────────────────────────────────────────────────────

function makeDefinition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    workflow_id: "wf-1",
    workflow_steps: [
      { agent: "dev", label: "Implement feature" },
      { agent: "research", label: "Verify findings" },
      { agent: "strategy", label: "Review approach" },
    ],
    current_step: 0,
    on_complete: "notify",
    ...overrides,
  };
}

function makeValidInput(overrides: Partial<WorkflowInput> = {}): WorkflowInput {
  return {
    workflow_id: "wf-1",
    workflow_steps: [
      { agent: "dev", label: "Implement feature" },
      { agent: "research", label: "Verify findings" },
    ],
    current_step: 0,
    on_complete: "notify",
    ...overrides,
  };
}

// ── validateStep ─────────────────────────────────────────────────────────────

describe("validateStep", () => {
  it("returns null for a valid step", () => {
    expect(validateStep({ agent: "dev", label: "Fix bug" }, 0)).toBeNull();
  });

  it("rejects non-object step", () => {
    expect(validateStep("not-an-object", 0)).toContain("must be an object");
  });

  it("rejects null step", () => {
    expect(validateStep(null, 1)).toContain("must be an object");
  });

  it("rejects missing agent", () => {
    expect(validateStep({ label: "Fix bug" }, 0)).toContain("agent");
  });

  it("rejects empty agent", () => {
    expect(validateStep({ agent: "", label: "Fix bug" }, 0)).toContain("agent");
  });

  it("rejects missing label", () => {
    expect(validateStep({ agent: "dev" }, 0)).toContain("label");
  });

  it("rejects empty label", () => {
    expect(validateStep({ agent: "dev", label: "  " }, 0)).toContain("label");
  });

  it("includes step index in error message", () => {
    const err = validateStep({ agent: "dev" }, 3);
    expect(err).toContain("[3]");
  });
});

// ── validateWorkflowInput — no workflow fields ───────────────────────────────

describe("validateWorkflowInput — no workflow", () => {
  it("returns valid with no definition when no fields present", () => {
    const result = validateWorkflowInput({});
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.definition).toBeUndefined();
  });

  it("returns valid with no definition for empty object", () => {
    const result = validateWorkflowInput({} as WorkflowInput);
    expect(result.valid).toBe(true);
    expect(result.definition).toBeUndefined();
  });
});

// ── validateWorkflowInput — valid inputs ─────────────────────────────────────

describe("validateWorkflowInput — valid", () => {
  it("accepts a complete valid workflow", () => {
    const result = validateWorkflowInput(makeValidInput());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.definition).toBeDefined();
    expect(result.definition!.workflow_id).toBe("wf-1");
    expect(result.definition!.workflow_steps).toHaveLength(2);
    expect(result.definition!.current_step).toBe(0);
    expect(result.definition!.on_complete).toBe("notify");
  });

  it("defaults current_step to 0", () => {
    const result = validateWorkflowInput(makeValidInput({ current_step: undefined }));
    expect(result.valid).toBe(true);
    expect(result.definition!.current_step).toBe(0);
  });

  it("defaults on_complete to 'notify'", () => {
    const result = validateWorkflowInput(makeValidInput({ on_complete: undefined }));
    expect(result.valid).toBe(true);
    expect(result.definition!.on_complete).toBe("notify");
  });

  it("accepts on_complete = 'auto'", () => {
    const result = validateWorkflowInput(makeValidInput({ on_complete: "auto" }));
    expect(result.valid).toBe(true);
    expect(result.definition!.on_complete).toBe("auto");
  });

  it("accepts step_context", () => {
    const result = validateWorkflowInput(makeValidInput({ step_context: "Previous output" }));
    expect(result.valid).toBe(true);
    expect(result.definition!.step_context).toBe("Previous output");
  });

  it("trims agent and label whitespace", () => {
    const result = validateWorkflowInput({
      workflow_id: "wf-1",
      workflow_steps: [{ agent: "  dev  ", label: "  Fix bug  " }],
    });
    expect(result.valid).toBe(true);
    expect(result.definition!.workflow_steps[0].agent).toBe("dev");
    expect(result.definition!.workflow_steps[0].label).toBe("Fix bug");
  });

  it("accepts a single-step workflow", () => {
    const result = validateWorkflowInput({
      workflow_id: "wf-single",
      workflow_steps: [{ agent: "dev", label: "Solo task" }],
    });
    expect(result.valid).toBe(true);
    expect(result.definition!.workflow_steps).toHaveLength(1);
  });
});

// ── validateWorkflowInput — invalid inputs ───────────────────────────────────

describe("validateWorkflowInput — invalid", () => {
  it("rejects missing workflow_id when other fields present", () => {
    const result = validateWorkflowInput({
      workflow_steps: [{ agent: "dev", label: "Task" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("workflow_id"))).toBe(true);
  });

  it("rejects empty workflow_id", () => {
    const result = validateWorkflowInput(makeValidInput({ workflow_id: "" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("workflow_id"))).toBe(true);
  });

  it("rejects non-array workflow_steps", () => {
    const result = validateWorkflowInput({
      workflow_id: "wf-1",
      workflow_steps: "not-an-array" as unknown as unknown[],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("must be an array"))).toBe(true);
  });

  it("rejects empty workflow_steps array", () => {
    const result = validateWorkflowInput(makeValidInput({ workflow_steps: [] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("at least one step"))).toBe(true);
  });

  it("rejects invalid step in workflow_steps", () => {
    const result = validateWorkflowInput(makeValidInput({
      workflow_steps: [{ agent: "dev", label: "Good" }, { agent: "", label: "Bad" }],
    }));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("[1].agent"))).toBe(true);
  });

  it("rejects negative current_step", () => {
    const result = validateWorkflowInput(makeValidInput({ current_step: -1 }));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("current_step"))).toBe(true);
  });

  it("rejects current_step out of bounds", () => {
    const result = validateWorkflowInput(makeValidInput({ current_step: 5 }));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("out of bounds"))).toBe(true);
  });

  it("rejects non-integer current_step", () => {
    const result = validateWorkflowInput(makeValidInput({ current_step: 1.5 }));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("current_step"))).toBe(true);
  });

  it("rejects invalid on_complete value", () => {
    const result = validateWorkflowInput(makeValidInput({ on_complete: "skip" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("on_complete"))).toBe(true);
  });

  it("rejects non-string step_context", () => {
    const result = validateWorkflowInput(makeValidInput({ step_context: 42 as unknown as string }));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("step_context"))).toBe(true);
  });

  it("collects multiple errors at once", () => {
    const result = validateWorkflowInput({
      workflow_steps: [],
      on_complete: "invalid",
      step_context: 123 as unknown as string,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ── getCurrentStep ───────────────────────────────────────────────────────────

describe("getCurrentStep", () => {
  it("returns the first step when current_step is 0", () => {
    const def = makeDefinition();
    const step = getCurrentStep(def);
    expect(step).not.toBeNull();
    expect(step!.agent).toBe("dev");
    expect(step!.label).toBe("Implement feature");
  });

  it("returns the correct step at index 1", () => {
    const def = makeDefinition({ current_step: 1 });
    const step = getCurrentStep(def);
    expect(step!.agent).toBe("research");
  });

  it("returns null when current_step is past the end", () => {
    const def = makeDefinition({ current_step: 3 });
    expect(getCurrentStep(def)).toBeNull();
  });

  it("returns the last step at last index", () => {
    const def = makeDefinition({ current_step: 2 });
    const step = getCurrentStep(def);
    expect(step!.agent).toBe("strategy");
  });
});

// ── advanceStep ──────────────────────────────────────────────────────────────

describe("advanceStep", () => {
  it("advances from step 0 to step 1", () => {
    const def = makeDefinition();
    const next = advanceStep(def);
    expect(next).not.toBeNull();
    expect(next!.current_step).toBe(1);
  });

  it("preserves other fields when advancing", () => {
    const def = makeDefinition({ on_complete: "auto" });
    const next = advanceStep(def)!;
    expect(next.workflow_id).toBe("wf-1");
    expect(next.on_complete).toBe("auto");
    expect(next.workflow_steps).toHaveLength(3);
  });

  it("carries context forward when provided", () => {
    const def = makeDefinition();
    const next = advanceStep(def, "Step 0 output data");
    expect(next!.step_context).toBe("Step 0 output data");
  });

  it("preserves existing context when no new context provided", () => {
    const def = makeDefinition({ step_context: "existing context" });
    const next = advanceStep(def);
    expect(next!.step_context).toBe("existing context");
  });

  it("returns null when at the last step", () => {
    const def = makeDefinition({ current_step: 2 });
    expect(advanceStep(def)).toBeNull();
  });

  it("does not mutate the original definition", () => {
    const def = makeDefinition();
    advanceStep(def, "new context");
    expect(def.current_step).toBe(0);
    expect(def.step_context).toBeUndefined();
  });
});

// ── isWorkflowComplete ───────────────────────────────────────────────────────

describe("isWorkflowComplete", () => {
  it("returns false at step 0 of 3", () => {
    expect(isWorkflowComplete(makeDefinition())).toBe(false);
  });

  it("returns false at step 1 of 3", () => {
    expect(isWorkflowComplete(makeDefinition({ current_step: 1 }))).toBe(false);
  });

  it("returns true at last step", () => {
    expect(isWorkflowComplete(makeDefinition({ current_step: 2 }))).toBe(true);
  });

  it("returns true for single-step workflow at step 0", () => {
    const def = makeDefinition({
      workflow_steps: [{ agent: "dev", label: "Solo" }],
      current_step: 0,
    });
    expect(isWorkflowComplete(def)).toBe(true);
  });
});

// ── getRemainingSteps ────────────────────────────────────────────────────────

describe("getRemainingSteps", () => {
  it("returns all except first when at step 0", () => {
    const remaining = getRemainingSteps(makeDefinition());
    expect(remaining).toHaveLength(2);
    expect(remaining[0].agent).toBe("research");
    expect(remaining[1].agent).toBe("strategy");
  });

  it("returns one step when at step 1 of 3", () => {
    const remaining = getRemainingSteps(makeDefinition({ current_step: 1 }));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].agent).toBe("strategy");
  });

  it("returns empty when at last step", () => {
    const remaining = getRemainingSteps(makeDefinition({ current_step: 2 }));
    expect(remaining).toHaveLength(0);
  });
});

// ── getCompletedSteps ────────────────────────────────────────────────────────

describe("getCompletedSteps", () => {
  it("returns empty when at step 0", () => {
    expect(getCompletedSteps(makeDefinition())).toHaveLength(0);
  });

  it("returns first step when at step 1", () => {
    const completed = getCompletedSteps(makeDefinition({ current_step: 1 }));
    expect(completed).toHaveLength(1);
    expect(completed[0].agent).toBe("dev");
  });

  it("returns first two steps when at step 2", () => {
    const completed = getCompletedSteps(makeDefinition({ current_step: 2 }));
    expect(completed).toHaveLength(2);
    expect(completed[0].agent).toBe("dev");
    expect(completed[1].agent).toBe("research");
  });
});
