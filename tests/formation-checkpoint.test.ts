import { describe, it, expect, beforeEach } from "bun:test";
import {
  initFormation,
  saveCheckpoint,
  getResumePoint,
  canResume,
  getFormationState,
  _resetForTesting,
} from "../src/formation-checkpoint.ts";

describe("ELLIE-1081: Formation checkpoint/resume", () => {
  beforeEach(() => _resetForTesting());

  describe("initFormation", () => {
    it("creates formation state", () => {
      const state = initFormation({ formationId: "f1", workflowName: "code-review", totalSteps: 3 });
      expect(state.status).toBe("running");
      expect(state.totalSteps).toBe(3);
    });
  });

  describe("saveCheckpoint", () => {
    it("records completed step", async () => {
      initFormation({ formationId: "f1", workflowName: "test", totalSteps: 3 });
      saveCheckpoint("f1", { stepIndex: 0, stepId: "lint", status: "completed", outputs: { clean: true } });
      const state = await getFormationState("f1");
      expect(state!.checkpoints.length).toBe(1);
      expect(state!.checkpoints[0].stepId).toBe("lint");
    });

    it("marks formation failed on step failure", async () => {
      initFormation({ formationId: "f1", workflowName: "test", totalSteps: 3 });
      saveCheckpoint("f1", { stepIndex: 0, stepId: "lint", status: "failed", outputs: {} });
      expect((await getFormationState("f1"))!.status).toBe("failed");
    });

    it("marks formation completed when all steps done", async () => {
      initFormation({ formationId: "f1", workflowName: "test", totalSteps: 2 });
      saveCheckpoint("f1", { stepIndex: 0, stepId: "lint", status: "completed", outputs: {} });
      saveCheckpoint("f1", { stepIndex: 1, stepId: "test", status: "completed", outputs: {} });
      expect((await getFormationState("f1"))!.status).toBe("completed");
    });
  });

  describe("getResumePoint", () => {
    it("returns last completed step and outputs", async () => {
      initFormation({ formationId: "f1", workflowName: "test", totalSteps: 5 });
      saveCheckpoint("f1", { stepIndex: 0, stepId: "lint", status: "completed", outputs: { clean: true } });
      saveCheckpoint("f1", { stepIndex: 1, stepId: "test", status: "completed", outputs: { passed: 42 } });
      saveCheckpoint("f1", { stepIndex: 2, stepId: "review", status: "failed", outputs: {} });

      const resume = await getResumePoint("f1");
      expect(resume).not.toBeNull();
      expect(resume!.lastCompletedStep).toBe(1);
      expect(resume!.completedOutputs.get("test")).toEqual({ passed: 42 });
    });

    it("returns null for unknown formation", async () => {
      expect(await getResumePoint("nonexistent")).toBeNull();
    });
  });

  describe("canResume", () => {
    it("can resume failed formations", async () => {
      initFormation({ formationId: "f1", workflowName: "test", totalSteps: 3 });
      saveCheckpoint("f1", { stepIndex: 0, stepId: "lint", status: "failed", outputs: {} });
      expect(await canResume("f1")).toBe(true);
    });

    it("cannot resume completed formations", async () => {
      initFormation({ formationId: "f1", workflowName: "test", totalSteps: 1 });
      saveCheckpoint("f1", { stepIndex: 0, stepId: "only", status: "completed", outputs: {} });
      expect(await canResume("f1")).toBe(false);
    });

    it("cannot resume running formations", async () => {
      initFormation({ formationId: "f1", workflowName: "test", totalSteps: 3 });
      expect(await canResume("f1")).toBe(false);
    });
  });
});
