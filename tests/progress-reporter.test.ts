import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mock dependencies ───────────────────────────────────────────────────────

mock.module("../src/logger.ts", () => ({
  log: {
    child: () => ({
      info: mock(),
      warn: mock(),
      error: mock(),
      debug: mock(),
    }),
  },
}));

mock.module("../src/orchestration-ledger.ts", () => ({
  emitEvent: mock(),
}));

mock.module("../src/relay-state.ts", () => ({
  broadcastDispatchEvent: mock(),
}));

const mockEmitDispatchEvent = mock(() => {});
mock.module("../src/dispatch-events.ts", () => ({
  emitDispatchEvent: mockEmitDispatchEvent,
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { reportProgress, extractProgressLine } from "../src/progress-reporter.ts";

describe("progress-reporter", () => {
  beforeEach(() => {
    mockEmitDispatchEvent.mockClear();
  });

  test("reportProgress emits a progress event", () => {
    reportProgress("run_123", "james", "Implement v2 API", "Reading schema files...");

    expect(mockEmitDispatchEvent).toHaveBeenCalledTimes(1);
    const [runId, eventType, payload] = mockEmitDispatchEvent.mock.calls[0];
    expect(runId).toBe("run_123");
    expect(eventType).toBe("progress");
    expect(payload.agent).toBe("james");
    expect(payload.progress_line).toBe("Reading schema files...");
  });

  test("reportProgress truncates long progress lines to 100 chars", () => {
    const longLine = "A".repeat(200);
    reportProgress("run_123", "james", "test", longLine);

    const payload = mockEmitDispatchEvent.mock.calls[0][2];
    expect(payload.progress_line.length).toBeLessThanOrEqual(103);
  });

  test("extractProgressLine extracts last meaningful line from investigation_state", () => {
    const state = "Looking at src/relay.ts for the startup sequence.\nFound the HTTP server setup on line 475.\nWriting new endpoint handler...";
    const line = extractProgressLine(state);
    expect(line).toBe("Writing new endpoint handler...");
  });

  test("extractProgressLine returns null for empty state", () => {
    expect(extractProgressLine("")).toBeNull();
    expect(extractProgressLine(null as unknown as string)).toBeNull();
  });
});
