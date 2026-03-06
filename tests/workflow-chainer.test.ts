/**
 * Workflow Chainer Tests — ELLIE-594
 *
 * Validates:
 *  - resolveChainAction() returns null when no workflow
 *  - resolveChainAction() returns "notify" action for notify mode
 *  - resolveChainAction() returns "auto" action for auto mode
 *  - resolveChainAction() returns "done" when workflow is complete
 *  - Message builders produce correct step N/total format
 *  - Context forwarding from completed step to next
 *  - Format helpers for Telegram and Google Chat
 */

import { describe, it, expect } from "bun:test";
import {
  resolveChainAction,
  buildNotifyMessage,
  buildAutoDispatchMessage,
  buildDoneMessage,
  formatChainForTelegram,
  formatChainForGChat,
  type WorkflowNotifyAction,
  type WorkflowAutoDispatchAction,
  type WorkflowDoneAction,
} from "../src/workflow-chainer.ts";
import type { WorkflowDefinition } from "../src/workflow-schema.ts";

// ── Helper ──────────────────────────────────────────────────────────────────

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    workflow_id: "wf-test",
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

// ── resolveChainAction — no workflow ─────────────────────────────────────────

describe("resolveChainAction — no workflow", () => {
  it("returns null when workflow is undefined", () => {
    expect(resolveChainAction(undefined, "Done", "ELLIE-100")).toBeNull();
  });
});

// ── resolveChainAction — notify mode ─────────────────────────────────────────

describe("resolveChainAction — notify", () => {
  it("returns notify action for first step completion", () => {
    const workflow = makeWorkflow();
    const action = resolveChainAction(workflow, "Reviewed and approved", "ELLIE-100");

    expect(action).not.toBeNull();
    expect(action!.type).toBe("notify");
    const notify = action as WorkflowNotifyAction;
    expect(notify.completedStep.agent).toBe("critic");
    expect(notify.nextStep.agent).toBe("dev");
    expect(notify.stepNumber).toBe(1);
    expect(notify.totalSteps).toBe(3);
  });

  it("includes step progress in message", () => {
    const workflow = makeWorkflow();
    const action = resolveChainAction(workflow, "Done", "ELLIE-100")!;

    expect(action.message).toContain("1/3");
    expect(action.message).toContain("critic");
    expect(action.message).toContain("dev");
    expect(action.message).toContain("ELLIE-100");
  });

  it("advances workflow definition to next step", () => {
    const workflow = makeWorkflow();
    const action = resolveChainAction(workflow, "Output data", "ELLIE-100") as WorkflowNotifyAction;

    expect(action.workflow.current_step).toBe(1);
  });

  it("forwards completion summary as step_context", () => {
    const workflow = makeWorkflow();
    const action = resolveChainAction(workflow, "My analysis results", "ELLIE-100") as WorkflowNotifyAction;

    expect(action.workflow.step_context).toBe("My analysis results");
  });

  it("returns notify for second step completion", () => {
    const workflow = makeWorkflow({ current_step: 1 });
    const action = resolveChainAction(workflow, "Fix applied", "ELLIE-100");

    expect(action!.type).toBe("notify");
    const notify = action as WorkflowNotifyAction;
    expect(notify.completedStep.agent).toBe("dev");
    expect(notify.nextStep.agent).toBe("research");
    expect(notify.stepNumber).toBe(2);
    expect(notify.totalSteps).toBe(3);
  });
});

// ── resolveChainAction — auto mode ───────────────────────────────────────────

describe("resolveChainAction — auto", () => {
  it("returns auto action with dispatch payload", () => {
    const workflow = makeWorkflow({ on_complete: "auto" });
    const action = resolveChainAction(workflow, "Review complete", "ELLIE-100");

    expect(action).not.toBeNull();
    expect(action!.type).toBe("auto");
    const auto = action as WorkflowAutoDispatchAction;
    expect(auto.dispatchPayload.agent).toBe("dev");
    expect(auto.dispatchPayload.label).toBe("Implement fix");
    expect(auto.dispatchPayload.step_context).toBe("Review complete");
    expect(auto.dispatchPayload.workflow_id).toBe("wf-test");
    expect(auto.dispatchPayload.current_step).toBe(1);
  });

  it("includes auto-dispatch in message", () => {
    const workflow = makeWorkflow({ on_complete: "auto" });
    const action = resolveChainAction(workflow, "Done", "ELLIE-100")!;

    expect(action.message).toContain("Auto-dispatching");
    expect(action.message).toContain("dev");
  });

  it("returns auto for middle step", () => {
    const workflow = makeWorkflow({ current_step: 1, on_complete: "auto" });
    const action = resolveChainAction(workflow, "Fix done", "ELLIE-100") as WorkflowAutoDispatchAction;

    expect(action.dispatchPayload.agent).toBe("research");
    expect(action.dispatchPayload.current_step).toBe(2);
    expect(action.stepNumber).toBe(2);
  });
});

// ── resolveChainAction — done ────────────────────────────────────────────────

describe("resolveChainAction — done", () => {
  it("returns done when last step completes", () => {
    const workflow = makeWorkflow({ current_step: 2 });
    const action = resolveChainAction(workflow, "Verified", "ELLIE-100");

    expect(action).not.toBeNull();
    expect(action!.type).toBe("done");
    const done = action as WorkflowDoneAction;
    expect(done.completedStep.agent).toBe("research");
    expect(done.totalSteps).toBe(3);
  });

  it("includes workflow ID in done message", () => {
    const workflow = makeWorkflow({ current_step: 2 });
    const action = resolveChainAction(workflow, "Done", "ELLIE-100")!;

    expect(action.message).toContain("wf-test");
    expect(action.message).toContain("complete");
    expect(action.message).toContain("3 steps");
    expect(action.message).toContain("ELLIE-100");
  });

  it("returns done for single-step workflow", () => {
    const workflow = makeWorkflow({
      workflow_steps: [{ agent: "dev", label: "Solo task" }],
      current_step: 0,
    });
    const action = resolveChainAction(workflow, "Done", "ELLIE-100");

    expect(action!.type).toBe("done");
  });

  it("returns done regardless of on_complete mode", () => {
    const workflow = makeWorkflow({ current_step: 2, on_complete: "auto" });
    const action = resolveChainAction(workflow, "Done", "ELLIE-100");

    expect(action!.type).toBe("done");
  });
});

// ── Message builders ─────────────────────────────────────────────────────────

describe("buildNotifyMessage", () => {
  it("includes step N/total format", () => {
    const msg = buildNotifyMessage(
      "ELLIE-100",
      { agent: "critic", label: "Review" },
      { agent: "dev", label: "Fix bug" },
      1, 3,
    );
    expect(msg).toContain("Step 1/3 done");
    expect(msg).toContain("critic: Review");
    expect(msg).toContain("Next: dev");
    expect(msg).toContain("ELLIE-100");
  });
});

describe("buildAutoDispatchMessage", () => {
  it("includes auto-dispatch language", () => {
    const msg = buildAutoDispatchMessage(
      "ELLIE-200",
      { agent: "research", label: "Investigate" },
      { agent: "dev", label: "Implement" },
      2, 4,
    );
    expect(msg).toContain("Step 2/4 done");
    expect(msg).toContain("Auto-dispatching");
    expect(msg).toContain("dev");
  });
});

describe("buildDoneMessage", () => {
  it("includes workflow ID and total steps", () => {
    const msg = buildDoneMessage("ELLIE-300", "wf-pipeline", 5);
    expect(msg).toContain("wf-pipeline");
    expect(msg).toContain("5 steps");
    expect(msg).toContain("ELLIE-300");
  });
});

// ── Format helpers ───────────────────────────────────────────────────────────

describe("formatChainForTelegram", () => {
  it("prefixes notify with link emoji", () => {
    const action = resolveChainAction(makeWorkflow(), "Done", "ELLIE-100")!;
    const formatted = formatChainForTelegram(action);
    expect(formatted).toMatch(/^🔗/);
  });

  it("prefixes auto with lightning emoji", () => {
    const action = resolveChainAction(makeWorkflow({ on_complete: "auto" }), "Done", "ELLIE-100")!;
    const formatted = formatChainForTelegram(action);
    expect(formatted).toMatch(/^⚡/);
  });

  it("prefixes done with checkmark emoji", () => {
    const action = resolveChainAction(makeWorkflow({ current_step: 2 }), "Done", "ELLIE-100")!;
    const formatted = formatChainForTelegram(action);
    expect(formatted).toMatch(/^✅/);
  });
});

describe("formatChainForGChat", () => {
  it("includes 'Workflow Step Complete' for notify", () => {
    const action = resolveChainAction(makeWorkflow(), "Done", "ELLIE-100")!;
    const formatted = formatChainForGChat(action);
    expect(formatted).toContain("Workflow Step Complete");
  });

  it("includes 'Auto-Dispatching' for auto", () => {
    const action = resolveChainAction(makeWorkflow({ on_complete: "auto" }), "Done", "ELLIE-100")!;
    const formatted = formatChainForGChat(action);
    expect(formatted).toContain("Auto-Dispatching Next Step");
  });

  it("includes 'Workflow Complete' for done", () => {
    const action = resolveChainAction(makeWorkflow({ current_step: 2 }), "Done", "ELLIE-100")!;
    const formatted = formatChainForGChat(action);
    expect(formatted).toContain("Workflow Complete");
  });
});

// ── Context forwarding ───────────────────────────────────────────────────────

describe("context forwarding", () => {
  it("passes summary as step_context in notify mode", () => {
    const workflow = makeWorkflow();
    const action = resolveChainAction(workflow, "Analysis: found 3 issues", "ELLIE-100") as WorkflowNotifyAction;
    expect(action.workflow.step_context).toBe("Analysis: found 3 issues");
  });

  it("passes summary as step_context in auto dispatch payload", () => {
    const workflow = makeWorkflow({ on_complete: "auto" });
    const action = resolveChainAction(workflow, "Reviewed: all good", "ELLIE-100") as WorkflowAutoDispatchAction;
    expect(action.dispatchPayload.step_context).toBe("Reviewed: all good");
  });

  it("preserves existing step_context when new summary is provided", () => {
    const workflow = makeWorkflow({ step_context: "old context" });
    const action = resolveChainAction(workflow, "new output", "ELLIE-100") as WorkflowNotifyAction;
    // New summary replaces old context
    expect(action.workflow.step_context).toBe("new output");
  });
});
