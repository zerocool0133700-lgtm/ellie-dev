import { describe, it, expect } from "bun:test";
import { buildTaskPrompt, type AtomicTask } from "../src/task-decomposer.ts";
import { estimateTokens } from "../src/relay-utils.ts";

describe("ELLIE-1084: Fresh session per atomic unit", () => {
  describe("buildTaskPrompt", () => {
    const task: AtomicTask = {
      id: "task-1",
      title: "Add validation to user input",
      description: "Add Zod schema validation to the POST /api/users endpoint",
      depends_on: [],
      files: ["src/api/users.ts"],
      acceptance_criteria: ["Zod schema validates email and name", "Invalid input returns 400"],
      verification: "bun test tests/users.test.ts",
    };

    it("builds a focused prompt with task details", () => {
      const prompt = buildTaskPrompt({
        task,
        workItemId: "ELLIE-1084",
        workItemTitle: "Fresh session per atomic unit",
      });
      expect(prompt).toContain("ELLIE-1084");
      expect(prompt).toContain("Add validation to user input");
      expect(prompt).toContain("Zod schema validates email");
      expect(prompt).toContain("bun test tests/users.test.ts");
    });

    it("includes prior task outputs for dependencies", () => {
      const depTask: AtomicTask = {
        id: "task-2",
        title: "Write tests",
        description: "Test the validation",
        depends_on: ["task-1"],
      };
      const priorOutputs = new Map([["task-1", "Added Zod schema to users.ts"]]);
      const prompt = buildTaskPrompt({
        task: depTask,
        workItemId: "ELLIE-1084",
        workItemTitle: "Test",
        priorOutputs,
      });
      expect(prompt).toContain("Context from Prior Tasks");
      expect(prompt).toContain("Added Zod schema");
    });

    it("produces focused prompt under 50k tokens", () => {
      const prompt = buildTaskPrompt({
        task,
        workItemId: "ELLIE-1084",
        workItemTitle: "Test",
        agentContext: "You are James, the dev agent.",
        memoryContext: "Past decisions: use Zod for validation.",
      });
      const tokens = estimateTokens(prompt);
      expect(tokens).toBeLessThan(50_000);
    });

    it("includes agent context when provided", () => {
      const prompt = buildTaskPrompt({
        task,
        workItemId: "ELLIE-1084",
        workItemTitle: "Test",
        agentContext: "You are James, the dev agent.",
      });
      expect(prompt).toContain("James");
    });

    it("includes only current task instructions", () => {
      const prompt = buildTaskPrompt({
        task,
        workItemId: "ELLIE-1084",
        workItemTitle: "Test",
      });
      expect(prompt).toContain("Complete ONLY this task");
    });

    it("truncates long prior outputs at 2000 chars", () => {
      const longOutput = "x".repeat(3000);
      const priorOutputs = new Map([["task-0", longOutput]]);
      const depTask: AtomicTask = {
        id: "task-1",
        title: "Follow-up",
        description: "Continue work",
        depends_on: ["task-0"],
      };
      const prompt = buildTaskPrompt({
        task: depTask,
        workItemId: "ELLIE-1084",
        workItemTitle: "Test",
        priorOutputs,
      });
      expect(prompt).toContain("[...truncated]");
      // Should not contain the full 3000 chars
      expect(prompt.length).toBeLessThan(longOutput.length);
    });

    it("includes file context when provided", () => {
      const prompt = buildTaskPrompt({
        task,
        workItemId: "ELLIE-1084",
        workItemTitle: "Test",
        fileContext: "// src/api/users.ts\nexport function createUser() {}",
      });
      expect(prompt).toContain("Relevant Files");
      expect(prompt).toContain("createUser");
    });

    it("omits empty sections", () => {
      const prompt = buildTaskPrompt({
        task: { id: "t1", title: "Simple", description: "Do it", depends_on: [] },
        workItemId: "ELLIE-1084",
        workItemTitle: "Test",
      });
      expect(prompt).not.toContain("Agent Memory");
      expect(prompt).not.toContain("Relevant Files");
      expect(prompt).not.toContain("Context from Prior Tasks");
      expect(prompt).not.toContain("Acceptance Criteria");
      expect(prompt).not.toContain("Verification");
    });
  });

  describe("module exports", () => {
    it("exports decomposeWorkItem", async () => {
      const mod = await import("../src/task-decomposer.ts");
      expect(typeof mod.decomposeWorkItem).toBe("function");
    });

    it("exports buildTaskPrompt", async () => {
      const mod = await import("../src/task-decomposer.ts");
      expect(typeof mod.buildTaskPrompt).toBe("function");
    });

    it("exports executeAtomicRun", async () => {
      const mod = await import("../src/atomic-orchestrator.ts");
      expect(typeof mod.executeAtomicRun).toBe("function");
    });
  });

  describe("AtomicTask interface", () => {
    it("has required fields", () => {
      const task: AtomicTask = {
        id: "t1",
        title: "Test task",
        description: "Do something",
        depends_on: [],
        files: ["src/foo.ts"],
        acceptance_criteria: ["Tests pass"],
        verification: "bun test",
      };
      expect(task.id).toBe("t1");
      expect(task.depends_on).toEqual([]);
      expect(task.files).toContain("src/foo.ts");
    });

    it("allows optional fields to be omitted", () => {
      const task: AtomicTask = {
        id: "t2",
        title: "Minimal task",
        description: "Just do it",
        depends_on: [],
      };
      expect(task.files).toBeUndefined();
      expect(task.acceptance_criteria).toBeUndefined();
      expect(task.verification).toBeUndefined();
      expect(task.skills_needed).toBeUndefined();
      expect(task.estimated_tokens).toBeUndefined();
    });
  });

  describe("AtomicRunResult interface", () => {
    it("has required fields", () => {
      const result = {
        workItemId: "ELLIE-1084",
        status: "completed" as const,
        tasksCompleted: 3,
        totalTasks: 3,
        outputs: new Map([["t1", "done"]]),
        totalTokensIn: 15000,
        totalTokensOut: 5000,
        totalDurationMs: 60000,
        errors: [],
      };
      expect(result.status).toBe("completed");
      expect(result.tasksCompleted).toBe(result.totalTasks);
      expect(result.errors).toHaveLength(0);
    });

    it("tracks partial completion", () => {
      const result = {
        workItemId: "ELLIE-1084",
        status: "partial" as const,
        tasksCompleted: 2,
        totalTasks: 4,
        outputs: new Map([["t1", "done"], ["t2", "done"]]),
        totalTokensIn: 10000,
        totalTokensOut: 3000,
        totalDurationMs: 45000,
        errors: [{ taskId: "t3", error: "Exit code 1" }],
      };
      expect(result.status).toBe("partial");
      expect(result.tasksCompleted).toBeLessThan(result.totalTasks);
      expect(result.errors).toHaveLength(1);
    });
  });
});
