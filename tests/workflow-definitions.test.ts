import { describe, it, expect } from "bun:test";
import { resolveExecutionOrder, resolveInputs, evaluateConditions, type WorkflowStep, type StepResult } from "../src/workflow-definitions.ts";

describe("ELLIE-1077: Deterministic workflow definitions", () => {
  describe("resolveExecutionOrder", () => {
    it("resolves linear dependencies", () => {
      const steps: WorkflowStep[] = [
        { id: "lint" },
        { id: "test", depends_on: ["lint"] },
        { id: "deploy", depends_on: ["test"] },
      ];
      expect(resolveExecutionOrder(steps)).toEqual(["lint", "test", "deploy"]);
    });

    it("handles parallel steps (no deps)", () => {
      const steps: WorkflowStep[] = [
        { id: "a" },
        { id: "b" },
        { id: "c", depends_on: ["a", "b"] },
      ];
      const order = resolveExecutionOrder(steps);
      expect(order.indexOf("c")).toBe(2);
      expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"));
      expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
    });

    it("throws on circular dependency", () => {
      const steps: WorkflowStep[] = [
        { id: "a", depends_on: ["b"] },
        { id: "b", depends_on: ["a"] },
      ];
      expect(() => resolveExecutionOrder(steps)).toThrow("Circular dependency");
    });

    it("throws on unknown dependency", () => {
      const steps: WorkflowStep[] = [
        { id: "a", depends_on: ["nonexistent"] },
      ];
      expect(() => resolveExecutionOrder(steps)).toThrow("unknown step");
    });

    it("handles single step", () => {
      expect(resolveExecutionOrder([{ id: "only" }])).toEqual(["only"]);
    });
  });

  describe("resolveInputs", () => {
    const results = new Map<string, StepResult>();
    results.set("classify", {
      stepId: "classify",
      status: "completed",
      outputs: { rules: ["rule1", "rule2"], count: 5 },
      durationMs: 100,
    });

    it("resolves template expressions", () => {
      const resolved = resolveInputs(
        { myRules: "${{ steps.classify.outputs.rules }}" },
        results
      );
      expect(resolved.myRules).toEqual(["rule1", "rule2"]);
    });

    it("passes through plain values", () => {
      const resolved = resolveInputs({ name: "hello" }, results);
      expect(resolved.name).toBe("hello");
    });

    it("returns null for missing step output", () => {
      const resolved = resolveInputs(
        { x: "${{ steps.missing.outputs.y }}" },
        results
      );
      expect(resolved.x).toBeNull();
    });
  });

  describe("evaluateConditions", () => {
    const results = new Map<string, StepResult>();
    results.set("analyze", {
      stepId: "analyze",
      status: "completed",
      outputs: { critical_count: 3, score: 85 },
      durationMs: 200,
    });

    it("evaluates > condition", () => {
      expect(evaluateConditions(
        ["${{ steps.analyze.outputs.critical_count > 0 }}"],
        results
      )).toBe(true);
    });

    it("evaluates == condition", () => {
      expect(evaluateConditions(
        ["${{ steps.analyze.outputs.critical_count == 3 }}"],
        results
      )).toBe(true);
    });

    it("returns false when condition not met", () => {
      expect(evaluateConditions(
        ["${{ steps.analyze.outputs.critical_count > 10 }}"],
        results
      )).toBe(false);
    });

    it("returns true for empty conditions", () => {
      expect(evaluateConditions([], results)).toBe(true);
    });
  });
});
