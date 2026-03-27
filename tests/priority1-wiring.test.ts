import { describe, it, expect } from "bun:test";

describe("Priority 1 wiring verification", () => {
  describe("Wire 1: buildPrompt is async", () => {
    it("buildPrompt returns a Promise", async () => {
      const mod = await import("../src/prompt-builder.ts");
      const result = mod.buildPrompt("test message");
      expect(result).toBeInstanceOf(Promise);
    });
  });

  describe("Wire 2: getSkillSnapshot accepts message parameter", () => {
    it("accepts optional message for progressive disclosure", async () => {
      const { getSkillSnapshot } = await import("../src/skills/snapshot.ts");
      // Should not throw with message parameter
      const snapshot = await getSkillSnapshot([], "test message");
      expect(snapshot).toHaveProperty("prompt");
    });
  });

  describe("Wire 3: filterTools is importable", () => {
    it("filterTools available from tool-discovery-filter", async () => {
      const mod = await import("../src/tool-discovery-filter.ts");
      expect(typeof mod.filterTools).toBe("function");
    });

    it("getDeferredToolSummary available from tool-discovery-filter", async () => {
      const mod = await import("../src/tool-discovery-filter.ts");
      expect(typeof mod.getDeferredToolSummary).toBe("function");
    });
  });

  describe("Wire 4: Brian's creature includes scoring framework", () => {
    it("brian.md contains Quality Scoring Framework section", async () => {
      const { readFile } = await import("node:fs/promises");
      const brian = await readFile("creatures/brian.md", "utf-8");
      expect(brian).toContain("Quality Scoring Framework");
      expect(brian).toContain("correctness, security, maintainability");
      expect(brian).toContain("P0 (blocking)");
    });
  });

  describe("Wire 5: readMemoriesForAgent exported from ellie-forest", () => {
    it("readMemoriesForAgent available", async () => {
      const mod = await import("../../ellie-forest/src/shared-memory.ts");
      expect(typeof mod.readMemoriesForAgent).toBe("function");
    });
  });
});
