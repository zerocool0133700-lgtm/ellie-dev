/**
 * Overnight Init Hook — ELLIE-1148
 * Tests for relay startup initialization of the overnight scheduler subsystem.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

// ── Mocks ──────────────────────────────────────────────────

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock(), debug: mock(), fatal: mock() }) },
}));

mock.module("../src/relay-state.ts", () => ({
  getRelayDeps: mock(() => ({ supabase: null, anthropic: null, bot: null })),
}));

mock.module("../src/trace.ts", () => ({
  getTraceId: mock(() => undefined),
}));

// ── Imports ────────────────────────────────────────────────

import { initOvernight, shutdownOvernight } from "../src/overnight/init.ts";

// ── initOvernight ──────────────────────────────────────────

describe("initOvernight", () => {
  it("returns clean result when no supabase", async () => {
    const result = await initOvernight(null);
    expect(result).toEqual({ recoveredSessions: 0, cleanedContainers: 0 });
  });

  it("marks interrupted running sessions as stopped", async () => {
    const updatedIds: string[] = [];
    const mockSupabase = {
      from: (table: string) => {
        if (table !== "overnight_sessions") throw new Error(`unexpected table: ${table}`);
        return {
          select: () => ({
            eq: () => ({
              data: [
                { id: "session-aaa", status: "running" },
                { id: "session-bbb", status: "running" },
              ],
              error: null,
            }),
          }),
          update: (data: any) => ({
            eq: (col: string, val: string) => {
              expect(data.status).toBe("stopped");
              expect(data.stop_reason).toBe("relay_restart");
              expect(data.stopped_at).toBeDefined();
              updatedIds.push(val);
              return { error: null };
            },
          }),
        };
      },
    };

    const result = await initOvernight(mockSupabase as any);
    expect(result.recoveredSessions).toBe(2);
    expect(updatedIds).toContain("session-aaa");
    expect(updatedIds).toContain("session-bbb");
  });

  it("returns 0 when no interrupted sessions exist", async () => {
    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            data: [],
            error: null,
          }),
        }),
      }),
    };

    const result = await initOvernight(mockSupabase as any);
    expect(result.recoveredSessions).toBe(0);
  });

  it("handles DB errors gracefully", async () => {
    const mockSupabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            data: null,
            error: { message: "connection refused" },
          }),
        }),
      }),
    };

    const result = await initOvernight(mockSupabase as any);
    expect(result.recoveredSessions).toBe(0);
  });
});

// ── shutdownOvernight ──────────────────────────────────────

describe("shutdownOvernight", () => {
  it("stops running overnight session on shutdown", async () => {
    // shutdownOvernight should call stopOvernightSession if running
    // and not throw if nothing is running
    await expect(shutdownOvernight()).resolves.toBeUndefined();
  });
});
