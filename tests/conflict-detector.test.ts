import { describe, test, expect, mock } from "bun:test";

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock(), debug: mock() }) },
}));

const mockGetRecentOutcomes = mock(async () => []);
mock.module("../src/dispatch-outcomes.ts", () => ({
  getRecentOutcomes: mockGetRecentOutcomes,
  readOutcome: mock(async () => null),
  writeOutcome: mock(async () => {}),
  readOutcomeWithParticipants: mock(async () => null),
}));

const mockGetActiveRunStates = mock(() => []);
mock.module("../src/orchestration-tracker.ts", () => ({
  getActiveRunStates: mockGetActiveRunStates,
}));

const mockGetRecentEvents = mock(async () => []);
mock.module("../src/orchestration-ledger.ts", () => ({
  getRecentEvents: mockGetRecentEvents,
  emitEvent: mock(),
}));

import { detectFileConflicts } from "../src/conflict-detector.ts";

describe("conflict-detector", () => {
  test("returns empty array when no active dispatches", async () => {
    mockGetActiveRunStates.mockReturnValue([]);
    const result = await detectFileConflicts("ELLIE-500");
    expect(result).toEqual([]);
  });

  test("returns empty when no file overlap", async () => {
    mockGetRecentOutcomes.mockResolvedValue([]);
    mockGetActiveRunStates.mockReturnValue([
      { runId: "active_1", agentType: "research", workItemId: "ELLIE-501", startedAt: Date.now(), status: "running" },
    ]);
    mockGetRecentEvents.mockResolvedValue([]);

    const result = await detectFileConflicts("ELLIE-500", ["src/api/auth.ts"]);
    expect(result).toEqual([]);
  });

  test("returns empty when no known files for work item", async () => {
    mockGetRecentOutcomes.mockResolvedValue([]);
    mockGetActiveRunStates.mockReturnValue([
      { runId: "active_1", agentType: "dev", workItemId: "ELLIE-501", startedAt: Date.now(), status: "running" },
    ]);

    const result = await detectFileConflicts("ELLIE-500");
    expect(result).toEqual([]);
  });
});
