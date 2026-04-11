import { describe, test, expect, mock } from "bun:test";

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock(), debug: mock() }) },
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

import { buildActiveDispatchContext } from "../src/active-dispatch-context.ts";

describe("active-dispatch-context", () => {
  test("returns null when no active dispatches", async () => {
    mockGetActiveRunStates.mockReturnValue([]);
    const result = await buildActiveDispatchContext();
    expect(result).toBeNull();
  });

  test("builds context string for active dispatches", async () => {
    mockGetActiveRunStates.mockReturnValue([
      { runId: "run_1", agentType: "dev", workItemId: "ELLIE-500", startedAt: Date.now() - 720000, status: "running" },
      { runId: "run_2", agentType: "research", workItemId: "ELLIE-501", startedAt: Date.now() - 180000, status: "running" },
    ]);
    mockGetRecentEvents.mockResolvedValue([
      { run_id: "run_1", event_type: "progress", payload: { agent: "james", title: "Implement v2 API", progress_line: "writing tests" }, created_at: new Date().toISOString() },
      { run_id: "run_2", event_type: "dispatched", payload: { agent: "kate", title: "Competitive analysis" }, created_at: new Date().toISOString() },
    ]);

    const result = await buildActiveDispatchContext();
    expect(result).not.toBeNull();
    expect(result).toContain("james");
    expect(result).toContain("ELLIE-500");
    expect(result).toContain("writing tests");
    expect(result).toContain("kate");
  });

  test("returns null when only completed runs exist", async () => {
    mockGetActiveRunStates.mockReturnValue([
      { runId: "run_1", agentType: "dev", status: "completed", startedAt: Date.now() - 60000 },
    ]);
    const result = await buildActiveDispatchContext();
    expect(result).toBeNull();
  });
});
