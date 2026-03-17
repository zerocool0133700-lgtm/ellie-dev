/**
 * ELLIE-837: Declarative workflow config parser tests
 */

import { describe, it, expect } from "bun:test";
import {
  parseWorkflowYaml,
  validateWorkflowConfig,
  type WorkflowConfig,
} from "../src/workflow-config.ts";

const VALID_WORKFLOW = `name: test-flow
description: A test workflow
triggers:
  - test workflow
  - run test
steps:
  - agent: research
    skill: none
    instruction: "Research the topic"
    timeout_seconds: 60
    produces: finding
  - agent: dev
    skill: code_changes
    instruction: "Implement based on research"
    consumes: finding
    produces: checkpoint
  - agent: critic
    skill: code_review
    instruction: "Review the implementation"
    consumes: checkpoint
    produces: review
`;

describe("ELLIE-837: Workflow config parser", () => {

  describe("parseWorkflowYaml", () => {
    it("parses a valid workflow config", () => {
      const config = parseWorkflowYaml(VALID_WORKFLOW);
      expect(config).not.toBeNull();
      expect(config!.name).toBe("test-flow");
      expect(config!.description).toBe("A test workflow");
      expect(config!.steps.length).toBe(3);
    });

    it("parses triggers array", () => {
      const config = parseWorkflowYaml(VALID_WORKFLOW);
      expect(config!.triggers).toEqual(["test workflow", "run test"]);
    });

    it("parses step details", () => {
      const config = parseWorkflowYaml(VALID_WORKFLOW);
      const step0 = config!.steps[0];
      expect(step0.agent).toBe("research");
      expect(step0.instruction).toBe("Research the topic");
      expect(step0.timeout_seconds).toBe(60);
      expect(step0.produces).toBe("finding");
    });

    it("parses consumes/produces on steps", () => {
      const config = parseWorkflowYaml(VALID_WORKFLOW);
      expect(config!.steps[1].consumes).toBe("finding");
      expect(config!.steps[1].produces).toBe("checkpoint");
    });

    it("returns null for invalid input", () => {
      expect(parseWorkflowYaml("")).toBeNull();
      expect(parseWorkflowYaml("random text")).toBeNull();
    });

    it("handles minimal workflow", () => {
      const minimal = `name: minimal
description: test
steps:
  - agent: dev
    instruction: "Do something"
`;
      const config = parseWorkflowYaml(minimal);
      expect(config).not.toBeNull();
      expect(config!.steps.length).toBe(1);
    });
  });

  describe("validateWorkflowConfig", () => {
    it("validates a correct config", () => {
      const config = parseWorkflowYaml(VALID_WORKFLOW)!;
      const result = validateWorkflowConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it("rejects empty name", () => {
      const config: WorkflowConfig = { name: "", description: "", steps: [{ agent: "dev", action: "none", instruction: "test" }] };
      const result = validateWorkflowConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === "name")).toBe(true);
    });

    it("rejects empty steps", () => {
      const config: WorkflowConfig = { name: "test", description: "", steps: [] };
      const result = validateWorkflowConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.field === "steps")).toBe(true);
    });

    it("rejects unknown agent", () => {
      const config: WorkflowConfig = {
        name: "test",
        description: "",
        steps: [{ agent: "nonexistent", action: "none", instruction: "test" }],
      };
      const result = validateWorkflowConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.message.includes("nonexistent"))).toBe(true);
    });

    it("rejects invalid message type in produces", () => {
      const config: WorkflowConfig = {
        name: "test",
        description: "",
        steps: [{ agent: "dev", action: "none", instruction: "test", produces: "bogus" as any }],
      };
      const result = validateWorkflowConfig(config);
      expect(result.valid).toBe(false);
    });

    it("rejects negative timeout", () => {
      const config: WorkflowConfig = {
        name: "test",
        description: "",
        steps: [{ agent: "dev", action: "none", instruction: "test", timeout_seconds: -1 }],
      };
      const result = validateWorkflowConfig(config);
      expect(result.valid).toBe(false);
    });

    it("accepts custom agent set", () => {
      const customAgents = new Set(["alpha", "beta"]);
      const config: WorkflowConfig = {
        name: "test",
        description: "",
        steps: [{ agent: "alpha", action: "none", instruction: "test" }],
      };
      const result = validateWorkflowConfig(config, customAgents);
      expect(result.valid).toBe(true);
    });
  });
});
