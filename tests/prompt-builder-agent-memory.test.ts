import { describe, it, expect } from "bun:test";
import { getModeSectionPriorities } from "../src/context-mode.ts";

describe("ELLIE-1028: Agent local memory in prompt builder", () => {
  describe("mode priorities include agent-local-memory", () => {
    it("conversation mode has agent-local-memory at priority 4", () => {
      const priorities = getModeSectionPriorities("conversation");
      expect(priorities["agent-local-memory"]).toBe(4);
    });

    it("deep-work mode has agent-local-memory at priority 3", () => {
      const priorities = getModeSectionPriorities("deep-work");
      expect(priorities["agent-local-memory"]).toBe(3);
    });

    it("strategy mode has agent-local-memory at priority 3", () => {
      const priorities = getModeSectionPriorities("strategy");
      expect(priorities["agent-local-memory"]).toBe(3);
    });

    it("skill-only mode suppresses agent-local-memory (priority 9)", () => {
      const priorities = getModeSectionPriorities("skill-only");
      expect(priorities["agent-local-memory"]).toBe(9);
    });

    it("fast mode suppresses agent-local-memory (priority 9)", () => {
      const priorities = getModeSectionPriorities("fast");
      expect(priorities["agent-local-memory"]).toBe(9);
    });

    it("workflow mode has agent-local-memory at priority 5", () => {
      const priorities = getModeSectionPriorities("workflow");
      expect(priorities["agent-local-memory"]).toBe(5);
    });
  });
});
