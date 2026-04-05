import { describe, test, expect, mock } from "bun:test";

// Mock ellie-forest (imported at top of bridge-river.ts)
mock.module('../../../ellie-forest/src/index', () => ({
  writeMemory: mock(() => Promise.resolve({ id: 'mem-1' })),
  sql: mock(),
  readMemories: mock(() => Promise.resolve([])),
  readMemoriesForAgent: mock(() => Promise.resolve([])),
  getScope: mock(() => Promise.resolve(null)),
  getChildScopes: mock(() => Promise.resolve([])),
  getBreadcrumb: mock(() => Promise.resolve([])),
  isAncestor: mock(() => Promise.resolve(false)),
  promoteToCore: mock(() => Promise.resolve(null)),
  demoteToExtended: mock(() => Promise.resolve(null)),
  convertToGoal: mock(() => Promise.resolve(null)),
  updateGoalStatus: mock(() => Promise.resolve(null)),
  completeGoal: mock(() => Promise.resolve(null)),
  getMemory: mock(() => Promise.resolve(null)),
  countByTier: mock(() => Promise.resolve({})),
}))

import { buildOakSummary } from "../src/api/bridge-river";

describe("buildOakSummary", () => {
  test("formats scope summaries into Oak index content", () => {
    const scopeData = [
      { scope_path: "2/1", name: "ellie-dev", count: 120, topFacts: ["Relay runs on port 3001", "Uses Bun runtime"] },
      { scope_path: "2/2", name: "ellie-forest", count: 45, topFacts: ["PostgreSQL-backed library", "Tree lifecycle with state machine"] },
      { scope_path: "E/1", name: "Voice & Personality", count: 30, topFacts: ["Warm, supportive tone", "Audio-first design"] },
    ];

    const result = buildOakSummary(scopeData);

    expect(result).toContain("Oak Knowledge Index");
    expect(result).toContain("3 domains");
    expect(result).toContain("195 total memories");
    expect(result).toContain("ellie-dev");
    expect(result).toContain("120 memories");
    expect(result).toContain("Relay runs on port 3001");
    expect(result).toContain("Voice & Personality");
  });

  test("handles empty scope data", () => {
    const result = buildOakSummary([]);
    expect(result).toContain("Oak Knowledge Index");
    expect(result).toContain("0 domains");
  });
});
