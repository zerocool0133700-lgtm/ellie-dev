/**
 * ELLIE-942 — Tests for session-spawn.ts
 *
 * Covers: spawn lifecycle, concurrency limits, timeout detection,
 * arc resolution (inherit/fork), thread binding, announcement building,
 * cost rollup, and registry queries.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
  spawnSession,
  markRunning,
  markCompleted,
  markFailed,
  markTimedOut,
  getSpawnRecord,
  getChildrenForParent,
  getActiveChildCount,
  getRegistrySize,
  checkTimeouts,
  buildAnnouncement,
  buildCostRollup,
  resolveArcForSpawn,
  captureDeliveryContext,
  killChildrenForParent,
  pruneCompletedSpawns,
  _clearRegistryForTesting,
} from "../src/session-spawn.ts";
import type { SpawnOpts, DeliveryContext } from "../src/types/session-spawn.ts";

// ── Helpers ──────────────────────────────────────────────────

function makeSpawnOpts(overrides: Partial<SpawnOpts> = {}): SpawnOpts {
  return {
    parentSessionId: "parent-session-1",
    parentAgentName: "dev",
    targetAgentName: "research",
    task: "Investigate the auth middleware compliance issue",
    channel: "telegram",
    userId: "user-1",
    ...overrides,
  };
}

beforeEach(() => {
  _clearRegistryForTesting();
});

// ── Spawn Lifecycle ──────────────────────────────────────────

describe("spawnSession", () => {
  test("creates a spawn record with correct defaults", () => {
    const result = spawnSession(makeSpawnOpts());

    expect(result.success).toBe(true);
    expect(result.spawnId).toBeTruthy();
    expect(result.childSessionKey).toMatch(/^agent:research:subagent:/);

    const record = getSpawnRecord(result.spawnId);
    expect(record).not.toBeNull();
    expect(record!.state).toBe("pending");
    expect(record!.arcMode).toBe("inherit");
    expect(record!.threadBound).toBe(false);
    expect(record!.timeoutSeconds).toBe(300);
    expect(record!.parentSessionId).toBe("parent-session-1");
    expect(record!.parentAgentName).toBe("dev");
    expect(record!.targetAgentName).toBe("research");
    expect(record!.task).toBe("Investigate the auth middleware compliance issue");
  });

  test("respects custom arcMode, threadBind, and timeout", () => {
    const result = spawnSession(
      makeSpawnOpts({
        arcMode: "fork",
        threadBind: true,
        timeoutSeconds: 600,
        parentArcId: "arc-parent-1",
      }),
    );

    expect(result.success).toBe(true);
    const record = getSpawnRecord(result.spawnId);
    expect(record!.arcMode).toBe("fork");
    expect(record!.threadBound).toBe(true);
    expect(record!.timeoutSeconds).toBe(600);
    // fork mode: stores parent arc ID for reference; resolveArcForSpawn creates the fork
    expect(record!.arcId).toBe("arc-parent-1");
  });

  test("inherit mode copies parent arc ID", () => {
    const result = spawnSession(
      makeSpawnOpts({
        arcMode: "inherit",
        parentArcId: "arc-parent-1",
      }),
    );

    const record = getSpawnRecord(result.spawnId);
    expect(record!.arcId).toBe("arc-parent-1");
  });

  test("captures delivery context when provided", () => {
    const ctx: DeliveryContext = {
      channel: "discord",
      threadId: "thread-123",
      webhookId: "wh-1",
      webhookToken: "token-abc",
      guildId: "guild-1",
    };

    const result = spawnSession(
      makeSpawnOpts({ deliveryContext: ctx }),
    );

    const record = getSpawnRecord(result.spawnId);
    expect(record!.deliveryContext).toEqual(ctx);
  });

  test("stores work item ID when provided", () => {
    const result = spawnSession(
      makeSpawnOpts({ workItemId: "ELLIE-100" }),
    );

    const record = getSpawnRecord(result.spawnId);
    expect(record!.workItemId).toBe("ELLIE-100");
  });
});

// ── Concurrency Limits ───────────────────────────────────────

describe("concurrency limits", () => {
  test("allows up to 5 concurrent children per parent", () => {
    for (let i = 0; i < 5; i++) {
      const result = spawnSession(makeSpawnOpts());
      expect(result.success).toBe(true);
    }

    // 6th should be rejected
    const rejected = spawnSession(makeSpawnOpts());
    expect(rejected.success).toBe(false);
    expect(rejected.error).toContain("Max concurrent children");
  });

  test("completed children don't count toward limit", () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const result = spawnSession(makeSpawnOpts());
      ids.push(result.spawnId);
    }

    // Complete 2 children
    markCompleted(ids[0], "Done");
    markCompleted(ids[1], "Done");

    // Now 2 more should be allowed
    expect(spawnSession(makeSpawnOpts()).success).toBe(true);
    expect(spawnSession(makeSpawnOpts()).success).toBe(true);

    // But a 6th active should fail
    expect(spawnSession(makeSpawnOpts()).success).toBe(false);
  });

  test("failed children don't count toward limit", () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const result = spawnSession(makeSpawnOpts());
      ids.push(result.spawnId);
    }

    markFailed(ids[0], "Some error");

    const result = spawnSession(makeSpawnOpts());
    expect(result.success).toBe(true);
  });

  test("different parents have independent limits", () => {
    // Fill parent-1
    for (let i = 0; i < 5; i++) {
      spawnSession(makeSpawnOpts({ parentSessionId: "parent-1" }));
    }

    // parent-2 should still work
    const result = spawnSession(makeSpawnOpts({ parentSessionId: "parent-2" }));
    expect(result.success).toBe(true);
  });
});

// ── State Transitions ────────────────────────────────────────

describe("state transitions", () => {
  test("markRunning transitions pending -> running", () => {
    const { spawnId } = spawnSession(makeSpawnOpts());
    const record = markRunning(spawnId, "real-session-id-1");

    expect(record).not.toBeNull();
    expect(record!.state).toBe("running");
    expect(record!.childSessionId).toBe("real-session-id-1");
  });

  test("markRunning without childSessionId keeps existing key", () => {
    const result = spawnSession(makeSpawnOpts());
    const originalKey = result.childSessionKey;
    const record = markRunning(result.spawnId);

    expect(record!.childSessionId).toBe(originalKey);
  });

  test("markCompleted transitions to completed with result", () => {
    const { spawnId } = spawnSession(makeSpawnOpts());
    markRunning(spawnId);
    const record = markCompleted(spawnId, "Research complete: found 3 issues");

    expect(record!.state).toBe("completed");
    expect(record!.resultText).toBe("Research complete: found 3 issues");
    expect(record!.endedAt).toBeGreaterThan(0);
  });

  test("markCompleted without resultText sets null", () => {
    const { spawnId } = spawnSession(makeSpawnOpts());
    const record = markCompleted(spawnId);
    expect(record!.resultText).toBeNull();
  });

  test("markFailed transitions to failed with error", () => {
    const { spawnId } = spawnSession(makeSpawnOpts());
    markRunning(spawnId);
    const record = markFailed(spawnId, "Agent crashed");

    expect(record!.state).toBe("failed");
    expect(record!.error).toBe("Agent crashed");
    expect(record!.endedAt).toBeGreaterThan(0);
  });

  test("markTimedOut transitions to timed_out", () => {
    const { spawnId } = spawnSession(makeSpawnOpts());
    markRunning(spawnId);
    const record = markTimedOut(spawnId);

    expect(record!.state).toBe("timed_out");
    expect(record!.error).toBe("Session spawn timed out");
  });

  test("state update on nonexistent ID returns null", () => {
    expect(markRunning("nonexistent")).toBeNull();
    expect(markCompleted("nonexistent")).toBeNull();
    expect(markFailed("nonexistent", "err")).toBeNull();
    expect(markTimedOut("nonexistent")).toBeNull();
  });
});

// ── Queries ──────────────────────────────────────────────────

describe("registry queries", () => {
  test("getSpawnRecord returns null for unknown ID", () => {
    expect(getSpawnRecord("nonexistent")).toBeNull();
  });

  test("getChildrenForParent returns all children", () => {
    spawnSession(makeSpawnOpts({ parentSessionId: "p1", targetAgentName: "research" }));
    spawnSession(makeSpawnOpts({ parentSessionId: "p1", targetAgentName: "critic" }));
    spawnSession(makeSpawnOpts({ parentSessionId: "p2", targetAgentName: "dev" }));

    const p1Children = getChildrenForParent("p1");
    expect(p1Children).toHaveLength(2);
    expect(p1Children.map((c) => c.targetAgentName).sort()).toEqual(["critic", "research"]);

    const p2Children = getChildrenForParent("p2");
    expect(p2Children).toHaveLength(1);
  });

  test("getChildrenForParent returns empty for unknown parent", () => {
    expect(getChildrenForParent("unknown")).toEqual([]);
  });

  test("getActiveChildCount counts only pending/running", () => {
    const r1 = spawnSession(makeSpawnOpts());
    const r2 = spawnSession(makeSpawnOpts());
    const r3 = spawnSession(makeSpawnOpts());

    markRunning(r1.spawnId);
    markCompleted(r2.spawnId, "done");
    // r3 stays pending

    expect(getActiveChildCount("parent-session-1")).toBe(2); // r1 running + r3 pending
  });
});

// ── Timeout Detection ────────────────────────────────────────

describe("checkTimeouts", () => {
  test("detects timed-out spawns", () => {
    const result = spawnSession(
      makeSpawnOpts({ timeoutSeconds: 0 }),
    );
    markRunning(result.spawnId);

    // With timeout=0, it should be expired immediately
    const timedOut = checkTimeouts();
    expect(timedOut).toContain(result.spawnId);

    const record = getSpawnRecord(result.spawnId);
    expect(record!.state).toBe("timed_out");
  });

  test("does not time out completed spawns", () => {
    const result = spawnSession(
      makeSpawnOpts({ timeoutSeconds: 0 }),
    );
    markCompleted(result.spawnId, "done");

    const timedOut = checkTimeouts();
    expect(timedOut).not.toContain(result.spawnId);
  });

  test("does not time out spawns within deadline", () => {
    const result = spawnSession(
      makeSpawnOpts({ timeoutSeconds: 9999 }),
    );
    markRunning(result.spawnId);

    const timedOut = checkTimeouts();
    expect(timedOut).not.toContain(result.spawnId);
  });

  test("times out pending spawns too", () => {
    const result = spawnSession(
      makeSpawnOpts({ timeoutSeconds: 0 }),
    );
    // stays pending, never marked running

    const timedOut = checkTimeouts();
    expect(timedOut).toContain(result.spawnId);
  });
});

// ── Announcement Builder ─────────────────────────────────────

describe("buildAnnouncement", () => {
  test("builds announcement for completed spawn", () => {
    const { spawnId } = spawnSession(makeSpawnOpts());
    markRunning(spawnId);
    markCompleted(spawnId, "Found 3 vulnerabilities");

    const announcement = buildAnnouncement(spawnId, 42);
    expect(announcement).not.toBeNull();
    expect(announcement!.state).toBe("completed");
    expect(announcement!.resultText).toBe("Found 3 vulnerabilities");
    expect(announcement!.costCents).toBe(42);
    expect(announcement!.durationMs).toBeGreaterThanOrEqual(0);
    expect(announcement!.targetAgentName).toBe("research");
    expect(announcement!.childSessionKey).toMatch(/^agent:research:subagent:/);
  });

  test("builds announcement for failed spawn", () => {
    const { spawnId } = spawnSession(makeSpawnOpts());
    markRunning(spawnId);
    markFailed(spawnId, "API rate limited");

    const announcement = buildAnnouncement(spawnId);
    expect(announcement!.state).toBe("failed");
    expect(announcement!.error).toBe("API rate limited");
    expect(announcement!.costCents).toBe(0);
  });

  test("returns null for unknown spawn", () => {
    expect(buildAnnouncement("nonexistent")).toBeNull();
  });

  test("duration reflects elapsed time for in-progress spawn", () => {
    const { spawnId } = spawnSession(makeSpawnOpts());
    markRunning(spawnId);

    const announcement = buildAnnouncement(spawnId);
    expect(announcement!.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── Cost Rollup ──────────────────────────────────────────────

describe("buildCostRollup", () => {
  test("returns zero rollup for parent with no children", async () => {
    const rollup = await buildCostRollup("no-children", async () => []);
    expect(rollup.parentSessionId).toBe("no-children");
    expect(rollup.totalCostCents).toBe(0);
    expect(rollup.childCount).toBe(0);
    expect(rollup.children).toEqual([]);
  });

  test("aggregates costs from multiple children", async () => {
    const r1 = spawnSession(makeSpawnOpts({ targetAgentName: "research" }));
    const r2 = spawnSession(makeSpawnOpts({ targetAgentName: "critic" }));

    const mockFetcher = async (sessionIds: string[]) => {
      expect(sessionIds).toHaveLength(2);
      return [
        {
          sessionId: getSpawnRecord(r1.spawnId)!.childSessionId,
          costCents: 15,
          inputTokens: 1000,
          outputTokens: 500,
        },
        {
          sessionId: getSpawnRecord(r2.spawnId)!.childSessionId,
          costCents: 25,
          inputTokens: 2000,
          outputTokens: 800,
        },
      ];
    };

    const rollup = await buildCostRollup("parent-session-1", mockFetcher);

    expect(rollup.totalCostCents).toBe(40);
    expect(rollup.totalInputTokens).toBe(3000);
    expect(rollup.totalOutputTokens).toBe(1300);
    expect(rollup.childCount).toBe(2);
    expect(rollup.children).toHaveLength(2);

    const research = rollup.children.find((c) => c.targetAgentName === "research");
    expect(research!.costCents).toBe(15);

    const critic = rollup.children.find((c) => c.targetAgentName === "critic");
    expect(critic!.costCents).toBe(25);
  });

  test("handles children with no cost data gracefully", async () => {
    spawnSession(makeSpawnOpts({ targetAgentName: "research" }));
    spawnSession(makeSpawnOpts({ targetAgentName: "critic" }));

    // Fetcher returns empty — no costs recorded yet
    const rollup = await buildCostRollup("parent-session-1", async () => []);

    expect(rollup.totalCostCents).toBe(0);
    expect(rollup.childCount).toBe(2);
    expect(rollup.children).toHaveLength(2);
    expect(rollup.children.every((c) => c.costCents === 0)).toBe(true);
  });
});

// ── Arc Resolution ───────────────────────────────────────────

describe("resolveArcForSpawn", () => {
  test("inherit mode returns parent arc ID directly", async () => {
    const { spawnId } = spawnSession(
      makeSpawnOpts({ arcMode: "inherit", parentArcId: "arc-123" }),
    );

    const mockCreateArc = mock(() => Promise.resolve({ id: "should-not-be-called" }));
    const arcId = await resolveArcForSpawn(spawnId, mockCreateArc);

    expect(arcId).toBe("arc-123");
    expect(mockCreateArc).not.toHaveBeenCalled();
  });

  test("inherit mode returns null when parent has no arc", async () => {
    const { spawnId } = spawnSession(makeSpawnOpts({ arcMode: "inherit" }));

    const mockCreateArc = mock(() => Promise.resolve({ id: "new-arc" }));
    const arcId = await resolveArcForSpawn(spawnId, mockCreateArc);

    expect(arcId).toBeNull();
    expect(mockCreateArc).not.toHaveBeenCalled();
  });

  test("fork mode creates a new arc with parent reference", async () => {
    const { spawnId } = spawnSession(
      makeSpawnOpts({
        arcMode: "fork",
        parentArcId: "arc-parent-1",
      }),
    );

    const mockCreateArc = mock((opts: any) => {
      expect(opts.name).toContain("research sub-task");
      expect(opts.category).toBe("work");
      expect(opts.direction).toBe("exploring");
      expect(opts.metadata.source).toBe("session_spawn");
      expect(opts.metadata.parent_arc_id).toBe("arc-parent-1");
      expect(opts.metadata.parent_session_id).toBe("parent-session-1");
      return Promise.resolve({ id: "forked-arc-1" });
    });

    const arcId = await resolveArcForSpawn(spawnId, mockCreateArc);

    expect(arcId).toBe("forked-arc-1");
    expect(mockCreateArc).toHaveBeenCalledTimes(1);

    // Verify the record was updated with the new arc ID
    const record = getSpawnRecord(spawnId);
    expect(record!.arcId).toBe("forked-arc-1");
  });

  test("returns null for unknown spawn", async () => {
    const result = await resolveArcForSpawn("nonexistent", async () => ({ id: "x" }));
    expect(result).toBeNull();
  });
});

// ── Thread Binding Helper ────────────────────────────────────

describe("captureDeliveryContext", () => {
  test("captures all fields", () => {
    const ctx = captureDeliveryContext({
      channel: "discord",
      chatId: "chat-1",
      threadId: "thread-1",
      webhookId: "wh-1",
      webhookToken: "token-abc",
      guildId: "guild-1",
    });

    expect(ctx).toEqual({
      channel: "discord",
      chatId: "chat-1",
      threadId: "thread-1",
      webhookId: "wh-1",
      webhookToken: "token-abc",
      guildId: "guild-1",
    });
  });

  test("omits undefined optional fields", () => {
    const ctx = captureDeliveryContext({ channel: "telegram" });

    expect(ctx.channel).toBe("telegram");
    expect(ctx.chatId).toBeUndefined();
    expect(ctx.threadId).toBeUndefined();
  });

  test("telegram context with chatId", () => {
    const ctx = captureDeliveryContext({
      channel: "telegram",
      chatId: 123456,
    });

    expect(ctx.channel).toBe("telegram");
    expect(ctx.chatId).toBe(123456);
  });
});

// ── Integration Scenarios ────────────────────────────────────

describe("integration scenarios", () => {
  test("full spawn lifecycle: spawn -> run -> complete -> announce -> rollup", async () => {
    // 1. Parent spawns a research sub-agent
    const spawnResult = spawnSession(
      makeSpawnOpts({
        arcMode: "inherit",
        parentArcId: "arc-main",
        threadBind: true,
        workItemId: "ELLIE-100",
        deliveryContext: { channel: "discord", threadId: "thread-1" },
      }),
    );
    expect(spawnResult.success).toBe(true);

    // 2. Child starts running
    markRunning(spawnResult.spawnId, "real-child-session");

    // 3. Verify active count
    expect(getActiveChildCount("parent-session-1")).toBe(1);

    // 4. Child completes
    markCompleted(spawnResult.spawnId, "Found 2 compliance gaps in auth middleware");

    // 5. Build announcement
    const announcement = buildAnnouncement(spawnResult.spawnId, 12);
    expect(announcement!.state).toBe("completed");
    expect(announcement!.resultText).toContain("compliance gaps");
    expect(announcement!.costCents).toBe(12);

    // 6. Build cost rollup
    const rollup = await buildCostRollup(
      "parent-session-1",
      async (ids) => {
        expect(ids).toContain("real-child-session");
        return [{ sessionId: "real-child-session", costCents: 12, inputTokens: 800, outputTokens: 400 }];
      },
    );
    expect(rollup.totalCostCents).toBe(12);
    expect(rollup.childCount).toBe(1);

    // 7. Active count should be 0 now
    expect(getActiveChildCount("parent-session-1")).toBe(0);
  });

  test("fan-out: parent spawns multiple children in parallel", async () => {
    const children = ["research", "critic", "dev"].map((agent) =>
      spawnSession(
        makeSpawnOpts({
          targetAgentName: agent,
          workItemId: "ELLIE-200",
        }),
      ),
    );

    expect(children.every((c) => c.success)).toBe(true);
    expect(getActiveChildCount("parent-session-1")).toBe(3);

    // Mark all running
    for (const child of children) markRunning(child.spawnId);

    // Complete research and critic, fail dev
    markCompleted(children[0].spawnId, "Research done");
    markCompleted(children[1].spawnId, "Review passed");
    markFailed(children[2].spawnId, "Build failed");

    expect(getActiveChildCount("parent-session-1")).toBe(0);

    const allChildren = getChildrenForParent("parent-session-1");
    expect(allChildren.filter((c) => c.state === "completed")).toHaveLength(2);
    expect(allChildren.filter((c) => c.state === "failed")).toHaveLength(1);
  });

  test("timeout recovery: timed-out slots free up for new spawns", () => {
    // Fill to capacity with 0-second timeout
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = spawnSession(makeSpawnOpts({ timeoutSeconds: 0 }));
      ids.push(r.spawnId);
      markRunning(r.spawnId);
    }
    expect(spawnSession(makeSpawnOpts()).success).toBe(false);

    // Run timeout check — all 5 should time out
    const timedOut = checkTimeouts();
    expect(timedOut).toHaveLength(5);

    // Now we can spawn again
    expect(spawnSession(makeSpawnOpts()).success).toBe(true);
  });
});

// ── ELLIE-948: Depth Enforcement ─────────────────────────────

describe("depth enforcement (ELLIE-948)", () => {
  test("allows depth 0 (direct child)", () => {
    const result = spawnSession(makeSpawnOpts({ depth: 0 }));
    expect(result.success).toBe(true);
    const record = getSpawnRecord(result.spawnId);
    expect(record!.depth).toBe(0);
  });

  test("allows depth 1 (grandchild)", () => {
    const result = spawnSession(makeSpawnOpts({ depth: 1 }));
    expect(result.success).toBe(true);
  });

  test("allows depth 2 (max allowed)", () => {
    const result = spawnSession(makeSpawnOpts({ depth: 2 }));
    expect(result.success).toBe(true);
  });

  test("rejects depth 3 (exceeds max)", () => {
    const result = spawnSession(makeSpawnOpts({ depth: 3 }));
    expect(result.success).toBe(false);
    expect(result.error).toContain("Max spawn depth");
    expect(result.error).toContain("depth=3");
  });

  test("defaults to depth 0 when not specified", () => {
    const result = spawnSession(makeSpawnOpts());
    const record = getSpawnRecord(result.spawnId);
    expect(record!.depth).toBe(0);
  });
});

// ── ELLIE-949: Cascade Kill ──────────────────────────────────

describe("killChildrenForParent (ELLIE-949)", () => {
  test("kills all active children for a parent", () => {
    const r1 = spawnSession(makeSpawnOpts({ targetAgentName: "research" }));
    const r2 = spawnSession(makeSpawnOpts({ targetAgentName: "critic" }));
    markRunning(r1.spawnId);
    // r2 stays pending

    const killed = killChildrenForParent("parent-session-1");
    expect(killed).toHaveLength(2);

    expect(getSpawnRecord(r1.spawnId)!.state).toBe("failed");
    expect(getSpawnRecord(r2.spawnId)!.state).toBe("failed");
    expect(getSpawnRecord(r1.spawnId)!.error).toContain("cascade kill");
  });

  test("skips already completed/failed children", () => {
    const r1 = spawnSession(makeSpawnOpts({ targetAgentName: "research" }));
    const r2 = spawnSession(makeSpawnOpts({ targetAgentName: "critic" }));
    markCompleted(r1.spawnId, "done");
    markRunning(r2.spawnId);

    const killed = killChildrenForParent("parent-session-1");
    expect(killed).toHaveLength(1);
    expect(killed[0]).toBe(r2.spawnId);

    // r1 should still be completed, not overwritten
    expect(getSpawnRecord(r1.spawnId)!.state).toBe("completed");
  });

  test("returns empty array when no active children", () => {
    const killed = killChildrenForParent("nonexistent-parent");
    expect(killed).toEqual([]);
  });

  test("uses custom reason when provided", () => {
    const r1 = spawnSession(makeSpawnOpts());
    markRunning(r1.spawnId);

    killChildrenForParent("parent-session-1", "Budget exceeded");
    expect(getSpawnRecord(r1.spawnId)!.error).toBe("Budget exceeded");
  });

  test("frees concurrency slots after cascade kill", () => {
    // Fill to capacity
    for (let i = 0; i < 5; i++) {
      spawnSession(makeSpawnOpts());
    }
    expect(spawnSession(makeSpawnOpts()).success).toBe(false);

    // Cascade kill
    killChildrenForParent("parent-session-1");
    expect(getActiveChildCount("parent-session-1")).toBe(0);

    // Can spawn again
    expect(spawnSession(makeSpawnOpts()).success).toBe(true);
  });
});

// ── ELLIE-951: Registry GC ───────────────────────────────────

describe("pruneCompletedSpawns (ELLIE-951)", () => {
  test("prunes completed spawns older than maxAge", () => {
    const r1 = spawnSession(makeSpawnOpts());
    markCompleted(r1.spawnId, "done");

    // Force endedAt to be old
    const record = getSpawnRecord(r1.spawnId)!;
    record.endedAt = Date.now() - 20 * 60_000; // 20 minutes ago

    const pruned = pruneCompletedSpawns(10 * 60_000); // 10 min threshold
    expect(pruned).toBe(1);
    expect(getSpawnRecord(r1.spawnId)).toBeNull();
  });

  test("does not prune recent completed spawns", () => {
    const r1 = spawnSession(makeSpawnOpts());
    markCompleted(r1.spawnId, "done");

    const pruned = pruneCompletedSpawns(10 * 60_000);
    expect(pruned).toBe(0);
    expect(getSpawnRecord(r1.spawnId)).not.toBeNull();
  });

  test("does not prune active spawns", () => {
    const r1 = spawnSession(makeSpawnOpts());
    markRunning(r1.spawnId);

    // Force createdAt to be old
    const record = getSpawnRecord(r1.spawnId)!;
    record.createdAt = Date.now() - 60 * 60_000;

    const pruned = pruneCompletedSpawns(1); // 1ms threshold — should still skip running
    expect(pruned).toBe(0);
    expect(getSpawnRecord(r1.spawnId)).not.toBeNull();
  });

  test("prunes failed and timed_out spawns too", () => {
    const r1 = spawnSession(makeSpawnOpts({ targetAgentName: "a" }));
    const r2 = spawnSession(makeSpawnOpts({ targetAgentName: "b" }));
    markFailed(r1.spawnId, "err");
    markTimedOut(r2.spawnId);

    // Make both old
    getSpawnRecord(r1.spawnId)!.endedAt = Date.now() - 20 * 60_000;
    getSpawnRecord(r2.spawnId)!.endedAt = Date.now() - 20 * 60_000;

    const pruned = pruneCompletedSpawns(10 * 60_000);
    expect(pruned).toBe(2);
    expect(getRegistrySize()).toBe(0);
  });

  test("cleans up parentIndex when all children pruned", () => {
    const r1 = spawnSession(makeSpawnOpts());
    markCompleted(r1.spawnId, "done");
    getSpawnRecord(r1.spawnId)!.endedAt = Date.now() - 20 * 60_000;

    pruneCompletedSpawns(10 * 60_000);

    // Parent should have no children
    expect(getChildrenForParent("parent-session-1")).toEqual([]);
  });
});
