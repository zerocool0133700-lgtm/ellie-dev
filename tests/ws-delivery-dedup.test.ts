/**
 * ELLIE-485 — WebSocket reconnect dedup tests
 *
 * Covers: drainMemoryBuffer correctly returns delivered IDs and clears buffer,
 * and that the dedup filter prevents DB catch-up from re-sending buffer-delivered
 * messages on the same reconnect.
 */
import { describe, test, expect } from "bun:test";
import { WebSocket } from "ws";
import { deliverResponse, drainMemoryBuffer } from "../src/ws-delivery.ts";

// ── Mock helpers ─────────────────────────────────────────────

function mockClosedWs(): WebSocket {
  return { readyState: WebSocket.CLOSED } as unknown as WebSocket;
}

function mockOpenWs(): WebSocket & { _sent: string[] } {
  const sent: string[] = [];
  return {
    readyState: WebSocket.OPEN,
    send: (data: string) => { sent.push(data); },
    _sent: sent,
  } as unknown as WebSocket & { _sent: string[] };
}

// ── Tests ─────────────────────────────────────────────────────

describe("drainMemoryBuffer — dedup (ELLIE-485)", () => {
  test("returns memoryId of buffered message after failed send", () => {
    const closedWs = mockClosedWs();
    // deliverResponse with a closed WS → pushes to memory buffer
    deliverResponse(closedWs, {
      type: "response", text: "hello", agent: "general",
      memoryId: "msg-111", ts: Date.now(),
    }, "user-dedup-1");

    const openWs = mockOpenWs();
    const ids = drainMemoryBuffer("user-dedup-1", openWs);

    expect(ids).toContain("msg-111");
    expect((openWs as unknown as { _sent: string[] })._sent).toHaveLength(1);
    const delivered = JSON.parse((openWs as unknown as { _sent: string[] })._sent[0]);
    expect(delivered.memoryId).toBe("msg-111");
    expect(delivered.buffered).toBe(true);
  });

  test("buffer is empty after drain — no double-drain", () => {
    const closedWs = mockClosedWs();
    deliverResponse(closedWs, {
      type: "response", text: "second", agent: "general",
      memoryId: "msg-222", ts: Date.now(),
    }, "user-dedup-2");

    const openWs = mockOpenWs();
    const ids1 = drainMemoryBuffer("user-dedup-2", openWs);
    expect(ids1).toHaveLength(1);

    // Second drain: buffer must be empty
    const ids2 = drainMemoryBuffer("user-dedup-2", openWs);
    expect(ids2).toHaveLength(0);
    expect((openWs as unknown as { _sent: string[] })._sent).toHaveLength(1); // still only 1 total send
  });

  test("DB catch-up filter excludes buffer-delivered IDs on same reconnect", () => {
    const closedWs = mockClosedWs();
    deliverResponse(closedWs, {
      type: "response", text: "buffered", agent: "general",
      memoryId: "msg-333", ts: Date.now(),
    }, "user-dedup-3");

    const openWs = mockOpenWs();
    const bufferedIds = drainMemoryBuffer("user-dedup-3", openWs);

    // Simulate DB returning both the buffered message and a separate missed one
    const dbRows = [
      { id: "msg-333", content: "buffered", role: "assistant", created_at: new Date().toISOString(), metadata: {} },
      { id: "msg-444", content: "other",    role: "assistant", created_at: new Date().toISOString(), metadata: {} },
    ];

    const toDeliver = dbRows.filter(m => !bufferedIds.includes(m.id));

    // Only the non-buffered message should be delivered from DB
    expect(toDeliver).toHaveLength(1);
    expect(toDeliver[0].id).toBe("msg-444");
  });

  test("null memoryId: buffered without ID, not included in deliveredIds", () => {
    const closedWs = mockClosedWs();
    deliverResponse(closedWs, {
      type: "response", text: "no-id", agent: "general",
      memoryId: null, ts: Date.now(),
    }, "user-dedup-4");

    const openWs = mockOpenWs();
    const ids = drainMemoryBuffer("user-dedup-4", openWs);

    // Message was delivered from buffer, but no ID to track
    expect(ids).toHaveLength(0);
    expect((openWs as unknown as { _sent: string[] })._sent).toHaveLength(1);
  });

  test("multiple buffered messages: all IDs returned", () => {
    const closedWs = mockClosedWs();
    deliverResponse(closedWs, { type: "response", text: "a", agent: "general", memoryId: "msg-A", ts: 1 }, "user-dedup-5");
    deliverResponse(closedWs, { type: "response", text: "b", agent: "general", memoryId: "msg-B", ts: 2 }, "user-dedup-5");

    const openWs = mockOpenWs();
    const ids = drainMemoryBuffer("user-dedup-5", openWs);

    expect(ids).toContain("msg-A");
    expect(ids).toContain("msg-B");
    expect((openWs as unknown as { _sent: string[] })._sent).toHaveLength(2);
  });
});
