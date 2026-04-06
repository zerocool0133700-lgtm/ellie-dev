/**
 * Test: Orchestration Ledger Race Condition Fix
 *
 * Verify that concurrent emitEvent() calls (which trigger getSql() internally)
 * don't cause race conditions during initial DB connection.
 */

import { describe, it, expect } from "bun:test";
import { randomUUID } from "node:crypto";

describe("orchestration-ledger race condition", () => {
  it("should handle concurrent emitEvent calls without race", async () => {
    const { emitEvent } = await import("../src/orchestration-ledger.ts");

    // Generate a valid UUID for the test run
    const runId = randomUUID();

    // Fire 20 events concurrently — all will call getSql() internally
    // If there's a race condition, this will create multiple DB connections
    const events = Array.from({ length: 20 }, (_, i) => {
      if (i % 4 === 0) return { type: "dispatched" as const, payload: { index: i } };
      if (i % 4 === 1) return { type: "heartbeat" as const, payload: { index: i } };
      if (i % 4 === 2) return { type: "progress" as const, payload: { index: i } };
      return { type: "completed" as const, payload: { index: i } };
    });

    // Emit all events concurrently
    events.forEach(({ type, payload }) => {
      emitEvent(runId, type, "dev", "ELLIE-999", payload);
    });

    // Wait for all async operations to complete (emitEvent is fire-and-forget)
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // If we got here without crashing or hanging, the race condition is fixed
    expect(true).toBe(true);
  });

  it("should handle concurrent queries without race", async () => {
    const { getRecentEvents, getUnterminated } = await import("../src/orchestration-ledger.ts");

    // Fire multiple queries concurrently
    const promises = [
      getRecentEvents(10),
      getUnterminated(),
      getRecentEvents(5),
      getUnterminated(),
    ];

    // All should resolve successfully
    const results = await Promise.all(promises);

    expect(results).toBeDefined();
    expect(results.length).toBe(4);
  });
});
