import { describe, test, expect, mock, beforeEach } from "bun:test";

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock(), debug: mock() }) },
}));

const mockUpdateWM = mock(async () => null);
const mockReadWM = mock(async () => null);
mock.module("../src/working-memory.ts", () => ({
  updateWorkingMemory: mockUpdateWM,
  readWorkingMemory: mockReadWM,
}));

mock.module("../src/relay-state.ts", () => ({
  broadcastDispatchEvent: mock(),
  broadcastToEllieChatClients: mock(),
}));

import {
  queueContextForAgent,
  checkQueuedContext,
  clearQueuedContext,
  QUEUED_CONTEXT_MARKER,
} from "../src/dispatch-context-queue.ts";

describe("dispatch-context-queue", () => {
  beforeEach(() => {
    mockUpdateWM.mockClear();
    mockReadWM.mockClear();
  });

  test("queueContextForAgent writes to working memory context_anchors", async () => {
    await queueContextForAgent("session_1", "james", "actually use the v2 API");

    expect(mockUpdateWM).toHaveBeenCalledTimes(1);
    const call = mockUpdateWM.mock.calls[0][0];
    expect(call.agent).toBe("james");
    expect(call.sections.context_anchors).toContain(QUEUED_CONTEXT_MARKER);
    expect(call.sections.context_anchors).toContain("actually use the v2 API");
  });

  test("checkQueuedContext returns messages when markers exist", async () => {
    mockReadWM.mockResolvedValue({
      sections: {
        context_anchors: `Some existing anchor\n${QUEUED_CONTEXT_MARKER} @ 14:30: actually use the v2 API\n${QUEUED_CONTEXT_MARKER} @ 14:32: also check the tests`,
      },
    });

    const messages = await checkQueuedContext("session_1", "james");
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain("actually use the v2 API");
    expect(messages[1]).toContain("also check the tests");
  });

  test("checkQueuedContext returns empty array when no markers", async () => {
    mockReadWM.mockResolvedValue({
      sections: {
        context_anchors: "Some existing anchor without markers",
      },
    });

    const messages = await checkQueuedContext("session_1", "james");
    expect(messages).toHaveLength(0);
  });

  test("checkQueuedContext returns empty array when no working memory", async () => {
    mockReadWM.mockResolvedValue(null);
    const messages = await checkQueuedContext("session_1", "james");
    expect(messages).toHaveLength(0);
  });

  test("clearQueuedContext removes marker lines from context_anchors", async () => {
    mockReadWM.mockResolvedValue({
      sections: {
        context_anchors: `Important anchor\n${QUEUED_CONTEXT_MARKER} @ 14:30: queued message\nAnother anchor`,
      },
    });

    await clearQueuedContext("session_1", "james");

    expect(mockUpdateWM).toHaveBeenCalledTimes(1);
    const sections = mockUpdateWM.mock.calls[0][0].sections;
    expect(sections.context_anchors).toContain("Important anchor");
    expect(sections.context_anchors).toContain("Another anchor");
    expect(sections.context_anchors).not.toContain(QUEUED_CONTEXT_MARKER);
  });
});
