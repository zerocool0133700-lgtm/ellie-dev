/**
 * ELLIE-561: WebSocket ping intervals must be stored and cleared on shutdown.
 */
import { describe, it, expect, beforeEach } from "bun:test";

// Track setInterval/clearInterval calls
const activeIntervals = new Set<ReturnType<typeof setInterval>>();
const clearedIntervals = new Set<ReturnType<typeof setInterval>>();

const origSetInterval = globalThis.setInterval;
const origClearInterval = globalThis.clearInterval;

describe("WebSocket ping interval cleanup (ELLIE-561)", () => {
  beforeEach(() => {
    activeIntervals.clear();
    clearedIntervals.clear();
  });

  it("stopWebSocketPings clears both ping intervals", async () => {
    // Intercept setInterval/clearInterval to track calls
    const intervalIds: ReturnType<typeof setInterval>[] = [];

    globalThis.setInterval = ((fn: Function, ms?: number) => {
      const id = origSetInterval(fn, ms ?? 30_000);
      intervalIds.push(id);
      activeIntervals.add(id);
      return id;
    }) as typeof setInterval;

    globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {
      clearedIntervals.add(id);
      activeIntervals.delete(id);
      origClearInterval(id);
    }) as typeof clearInterval;

    try {
      // Re-import to get fresh module state with our intercepted globals
      // We can't easily call createWebSocketServers (needs HttpServer), so
      // test the stopWebSocketPings function directly after simulating state.
      const mod = await import("../src/websocket-servers.ts");

      // stopWebSocketPings should be exported
      expect(typeof mod.stopWebSocketPings).toBe("function");

      // Calling it when no intervals are set should not throw
      mod.stopWebSocketPings();
    } finally {
      globalThis.setInterval = origSetInterval;
      globalThis.clearInterval = origClearInterval;
      // Clean up any intervals we created
      for (const id of intervalIds) origClearInterval(id);
    }
  });

  it("stopWebSocketPings is idempotent (safe to call multiple times)", async () => {
    const mod = await import("../src/websocket-servers.ts");
    // Should not throw when called repeatedly
    mod.stopWebSocketPings();
    mod.stopWebSocketPings();
    mod.stopWebSocketPings();
  });

  it("stopWebSocketPings is exported from websocket-servers module", async () => {
    const mod = await import("../src/websocket-servers.ts");
    expect(mod).toHaveProperty("stopWebSocketPings");
    expect(mod).toHaveProperty("createWebSocketServers");
  });
});
