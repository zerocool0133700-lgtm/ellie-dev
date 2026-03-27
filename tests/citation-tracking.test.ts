import { describe, it, expect } from "bun:test";

describe("ELLIE-1046: Citation tracking", () => {
  it("exports required functions", async () => {
    const mod = await import("../../ellie-forest/src/citations.ts");
    expect(typeof mod.recordCitation).toBe("function");
    expect(typeof mod.recordCitations).toBe("function");
    expect(typeof mod.getCitationsForResponse).toBe("function");
    expect(typeof mod.getMostCitedMemories).toBe("function");
    expect(typeof mod.boostCitedMemories).toBe("function");
  });
});
