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

describe("active-dispatch-context thread filtering", () => {
  test("filters to only dispatches in the given thread", async () => {
    mockGetActiveRunStates.mockReturnValue([
      { runId: "run_1", agentType: "dev", workItemId: "ELLIE-500", startedAt: Date.now() - 60000, status: "running", thread_id: "thread-A" },
      { runId: "run_2", agentType: "research", workItemId: "ELLIE-501", startedAt: Date.now() - 30000, status: "running", thread_id: "thread-B" },
    ]);
    mockGetRecentEvents.mockResolvedValue([
      { run_id: "run_1", event_type: "dispatched", payload: { agent: "james", title: "v2 API" }, created_at: new Date().toISOString() },
      { run_id: "run_2", event_type: "dispatched", payload: { agent: "kate", title: "Research" }, created_at: new Date().toISOString() },
    ]);

    const result = await buildActiveDispatchContext("thread-A");
    expect(result).not.toBeNull();
    expect(result).toContain("james");
    expect(result).not.toContain("kate");
  });

  test("returns all dispatches when no thread filter", async () => {
    mockGetActiveRunStates.mockReturnValue([
      { runId: "run_1", agentType: "dev", startedAt: Date.now(), status: "running", thread_id: "thread-A" },
      { runId: "run_2", agentType: "research", startedAt: Date.now(), status: "running", thread_id: "thread-B" },
    ]);
    mockGetRecentEvents.mockResolvedValue([
      { run_id: "run_1", event_type: "dispatched", payload: { agent: "james", title: "Work" }, created_at: new Date().toISOString() },
      { run_id: "run_2", event_type: "dispatched", payload: { agent: "kate", title: "Research" }, created_at: new Date().toISOString() },
    ]);

    const result = await buildActiveDispatchContext();
    expect(result).not.toBeNull();
    expect(result).toContain("james");
    expect(result).toContain("kate");
  });
});
