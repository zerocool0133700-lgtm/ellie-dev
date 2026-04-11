import { describe, test, expect, mock, beforeEach } from "bun:test";

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock(), debug: mock() }) },
}));

const mockEmitEvent = mock(() => {});
mock.module("../src/orchestration-ledger.ts", () => ({
  emitEvent: mockEmitEvent,
}));

const mockBroadcast = mock(() => {});
mock.module("../src/relay-state.ts", () => ({
  broadcastToEllieChatClients: mockBroadcast,
  broadcastDispatchEvent: mockBroadcast,
}));

import {
  emitDispatchEvent,
  buildDispatchWebSocketPayload,
} from "../src/dispatch-events.ts";

describe("dispatch-events", () => {
  beforeEach(() => {
    mockEmitEvent.mockClear();
    mockBroadcast.mockClear();
  });

  test("emitDispatchEvent writes to ledger and broadcasts to WebSocket", () => {
    emitDispatchEvent("run_123", "dispatched", {
      agent: "james",
      title: "Implement v2 API",
      work_item_id: "ELLIE-500",
      dispatch_type: "single",
    });

    expect(mockEmitEvent).toHaveBeenCalledTimes(1);
    const [runId, eventType, agentType, workItemId, payload] = mockEmitEvent.mock.calls[0];
    expect(runId).toBe("run_123");
    expect(eventType).toBe("dispatched");
    expect(agentType).toBe("james");
    expect(workItemId).toBe("ELLIE-500");
    expect(payload.agent).toBe("james");
    expect(payload.title).toBe("Implement v2 API");
    expect(payload.dispatch_type).toBe("single");

    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    const wsPayload = mockBroadcast.mock.calls[0][0];
    expect(wsPayload.type).toBe("dispatch_event");
    expect(wsPayload.run_id).toBe("run_123");
    expect(wsPayload.agent).toBe("james");
  });

  test("emitDispatchEvent includes progress_line when provided", () => {
    emitDispatchEvent("run_123", "progress", {
      agent: "james",
      title: "Implement v2 API",
      progress_line: "Running 12 tests...",
      dispatch_type: "single",
    });

    const payload = mockEmitEvent.mock.calls[0][4];
    expect(payload.progress_line).toBe("Running 12 tests...");
  });

  test("emitDispatchEvent includes terminal event fields", () => {
    emitDispatchEvent("run_123", "completed", {
      agent: "james",
      title: "Implement v2 API",
      dispatch_type: "single",
      duration_ms: 45000,
      cost_usd: 0.12,
    });

    const wsPayload = mockBroadcast.mock.calls[0][0];
    expect(wsPayload.duration_ms).toBe(45000);
    expect(wsPayload.cost_usd).toBe(0.12);
  });

  test("buildDispatchWebSocketPayload maps event_type to status correctly", () => {
    const cases: Array<[string, string]> = [
      ["dispatched", "dispatched"],
      ["progress", "in_progress"],
      ["completed", "done"],
      ["failed", "failed"],
      ["stalled", "stalled"],
      ["cancelled", "cancelled"],
    ];
    for (const [eventType, expectedStatus] of cases) {
      const result = buildDispatchWebSocketPayload("run_1", eventType as any, { agent: "james", title: "test", dispatch_type: "single" });
      expect(result.status).toBe(expectedStatus);
    }
  });
});
