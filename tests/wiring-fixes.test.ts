import { describe, it, expect } from "bun:test";

describe("Critical wiring fixes", () => {
  describe("Fix 1: applyTokenBudgetWithCompression exists", () => {
    it("exports async compression-aware budget function", async () => {
      const mod = await import("../src/relay-utils.ts");
      expect(typeof mod.applyTokenBudgetWithCompression).toBe("function");
    });
  });

  describe("Fix 2: Cost tracking exports", () => {
    it("recordUsage and shouldBlock are importable", async () => {
      const mod = await import("../src/creature-cost-tracker.ts");
      expect(typeof mod.recordUsage).toBe("function");
      expect(typeof mod.shouldBlock).toBe("function");
    });
  });

  describe("Fix 3: Scoped memory search", () => {
    it("readMemoriesForAgent is exported from ellie-forest", async () => {
      const mod = await import("../../ellie-forest/src/shared-memory.ts");
      expect(typeof mod.readMemoriesForAgent).toBe("function");
    });
  });
});
