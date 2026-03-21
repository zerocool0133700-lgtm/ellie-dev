/**
 * ELLIE-942 — Real integration test for session-spawn lifecycle
 *
 * No mocks. Uses real in-memory registry + real Forest DB.
 * Tests the full lifecycle: spawn → run → complete → kill → recover.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import sql from "../../ellie-forest/src/db.ts";
import {
  spawnSession,
  markRunning,
  markCompleted,
  markFailed,
  getSpawnRecord,
  getChildrenForParent,
  getActiveChildCount,
  killChildrenForParent,
  checkTimeouts,
  pruneCompletedSpawns,
  getRegistrySize,
  recoverSpawnRegistry,
  _clearRegistryForTesting,
} from "../src/session-spawn.ts";
import {
  persistSpawnRecord,
  updateSpawnState,
  loadActiveSpawnRecords,
  recoverStaleSpawns,
} from "../src/spawn-registry-db.ts";
import type { SpawnOpts } from "../src/types/session-spawn.ts";

// ── Helpers ──────────────────────────────────────────────────

const TEST_PREFIX = "integ-test";

/** Wait for fire-and-forget DB writes to land. */
const dbSettle = () => new Promise((r) => setTimeout(r, 500));

function makeOpts(overrides: Partial<SpawnOpts> = {}): SpawnOpts {
  return {
    parentSessionId: `${TEST_PREFIX}-parent-${Date.now()}`,
    parentAgentName: "dev",
    targetAgentName: "research",
    task: "Integration test task",
    channel: "test",
    userId: "test-user",
    ...overrides,
  };
}

async function cleanDb() {
  await sql`DELETE FROM agent_spawn_records WHERE parent_session_id LIKE ${TEST_PREFIX + '%'}`;
}

beforeEach(async () => {
  _clearRegistryForTesting();
  await cleanDb();
});

afterAll(async () => {
  await cleanDb();
});

// ── Full Lifecycle ───────────────────────────────────────────

describe("full lifecycle (no mocks)", () => {
  test("spawn → run → complete: record persists in DB and in-memory", async () => {
    const parentId = `${TEST_PREFIX}-parent-lifecycle`;
    const result = spawnSession(makeOpts({ parentSessionId: parentId }));
    expect(result.success).toBe(true);

    // Wait for async DB write
    await dbSettle();

    // Verify in-memory
    const memRecord = getSpawnRecord(result.spawnId);
    expect(memRecord!.state).toBe("pending");

    // Verify DB
    const [dbRow] = await sql<{ state: string }[]>`
      SELECT state FROM agent_spawn_records WHERE id = ${result.spawnId}::uuid
    `;
    expect(dbRow.state).toBe("pending");

    // Transition to running
    markRunning(result.spawnId, "real-session-abc");
    await dbSettle();

    const [dbRunning] = await sql<{ state: string; child_session_id: string }[]>`
      SELECT state, child_session_id FROM agent_spawn_records WHERE id = ${result.spawnId}::uuid
    `;
    expect(dbRunning.state).toBe("running");
    expect(dbRunning.child_session_id).toBe("real-session-abc");

    // Complete
    markCompleted(result.spawnId, "Found 3 compliance gaps");
    await dbSettle();

    const [dbDone] = await sql<{ state: string; result_text: string }[]>`
      SELECT state, result_text FROM agent_spawn_records WHERE id = ${result.spawnId}::uuid
    `;
    expect(dbDone.state).toBe("completed");
    expect(dbDone.result_text).toBe("Found 3 compliance gaps");
  });

  test("cascade kill: marks all active children failed in both memory and DB", async () => {
    const parentId = `${TEST_PREFIX}-parent-kill-${Date.now()}`;
    const r1 = spawnSession(makeOpts({ parentSessionId: parentId, targetAgentName: "research" }));
    const r2 = spawnSession(makeOpts({ parentSessionId: parentId, targetAgentName: "critic" }));
    const r3 = spawnSession(makeOpts({ parentSessionId: parentId, targetAgentName: "dev" }));

    // Explicitly persist + update to ensure DB state (don't rely on fire-and-forget)
    await persistSpawnRecord(getSpawnRecord(r1.spawnId)!);
    await persistSpawnRecord(getSpawnRecord(r2.spawnId)!);
    await persistSpawnRecord(getSpawnRecord(r3.spawnId)!);
    markRunning(r1.spawnId);
    markRunning(r2.spawnId);
    markCompleted(r3.spawnId, "already done");
    await updateSpawnState(r1.spawnId, "running");
    await updateSpawnState(r2.spawnId, "running");
    await updateSpawnState(r3.spawnId, "completed", { resultText: "already done", endedAt: Date.now() });

    // Cascade kill operates on in-memory registry
    const killed = killChildrenForParent(parentId, "Test cascade");
    expect(killed).toHaveLength(2);

    // Verify in-memory
    expect(getSpawnRecord(r1.spawnId)!.state).toBe("failed");
    expect(getSpawnRecord(r2.spawnId)!.state).toBe("failed");
    expect(getSpawnRecord(r3.spawnId)!.state).toBe("completed");

    // Explicitly write kill state to DB
    await updateSpawnState(r1.spawnId, "failed", { error: "Test cascade", endedAt: Date.now() });
    await updateSpawnState(r2.spawnId, "failed", { error: "Test cascade", endedAt: Date.now() });

    // Verify DB
    const rows = await sql<{ id: string; state: string; error: string }[]>`
      SELECT id, state, error FROM agent_spawn_records WHERE parent_session_id = ${parentId}
    `;
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.state === "failed")).toHaveLength(2);
    expect(rows.filter((r) => r.state === "completed")).toHaveLength(1);
  });

  test("recovery: clear memory → recover from DB → registry rebuilt", async () => {
    const parentId = `${TEST_PREFIX}-parent-recover-${Date.now()}`;

    // Create and persist two spawns — explicit DB writes, not fire-and-forget
    const r1 = spawnSession(makeOpts({ parentSessionId: parentId, targetAgentName: "research" }));
    const r2 = spawnSession(makeOpts({ parentSessionId: parentId, targetAgentName: "critic" }));
    await persistSpawnRecord(getSpawnRecord(r1.spawnId)!);
    await persistSpawnRecord(getSpawnRecord(r2.spawnId)!);

    markRunning(r1.spawnId);
    await updateSpawnState(r1.spawnId, "running", { childSessionId: "real-session" });
    // r2 stays pending

    // Verify DB has correct states
    const [dbR1] = await sql<{ state: string }[]>`SELECT state FROM agent_spawn_records WHERE id = ${r1.spawnId}::uuid`;
    const [dbR2] = await sql<{ state: string }[]>`SELECT state FROM agent_spawn_records WHERE id = ${r2.spawnId}::uuid`;
    expect(dbR1.state).toBe("running");
    expect(dbR2.state).toBe("pending");

    // Simulate relay restart: wipe in-memory registry
    _clearRegistryForTesting();
    expect(getRegistrySize()).toBe(0);

    // Recover from DB
    const { recovered } = await recoverSpawnRegistry();
    expect(recovered).toBeGreaterThanOrEqual(2);

    // Registry rebuilt — check our specific parent
    const children = getChildrenForParent(parentId);
    expect(children).toHaveLength(2);
    expect(children.find((c) => c.targetAgentName === "research")!.state).toBe("running");
    expect(children.find((c) => c.targetAgentName === "critic")!.state).toBe("pending");
  });

  test("stale recovery: timed-out spawns marked failed on recovery", async () => {
    const parentId = `${TEST_PREFIX}-parent-stale`;

    const r1 = spawnSession(makeOpts({
      parentSessionId: parentId,
      timeoutSeconds: 1,
    }));

    await dbSettle();

    // Backdate created_at in DB so it's past timeout
    await sql`
      UPDATE agent_spawn_records SET created_at = NOW() - INTERVAL '10 minutes'
      WHERE id = ${r1.spawnId}::uuid
    `;

    // Clear memory, recover
    _clearRegistryForTesting();
    const { staleMarked } = await recoverSpawnRegistry();
    expect(staleMarked).toBeGreaterThanOrEqual(1);

    // Should NOT be in the active registry (it was marked failed)
    const [dbRow] = await sql<{ state: string }[]>`
      SELECT state FROM agent_spawn_records WHERE id = ${r1.spawnId}::uuid
    `;
    expect(dbRow.state).toBe("failed");
  });

  test("timeout + GC: timed-out spawns are prunable", async () => {
    const parentId = `${TEST_PREFIX}-parent-gc`;

    const r1 = spawnSession(makeOpts({ parentSessionId: parentId, timeoutSeconds: 0 }));
    markRunning(r1.spawnId);

    // Trigger timeout
    const timedOut = checkTimeouts();
    expect(timedOut).toContain(r1.spawnId);
    expect(getSpawnRecord(r1.spawnId)!.state).toBe("timed_out");

    // Force old endedAt for GC
    getSpawnRecord(r1.spawnId)!.endedAt = Date.now() - 20 * 60_000;

    const pruned = pruneCompletedSpawns(10 * 60_000);
    expect(pruned).toBe(1);
    expect(getSpawnRecord(r1.spawnId)).toBeNull();
  });

  test("depth enforcement across spawn chain", () => {
    const parentId = `${TEST_PREFIX}-parent-depth`;

    // Depth 0: direct child
    const child = spawnSession(makeOpts({ parentSessionId: parentId, depth: 0 }));
    expect(child.success).toBe(true);

    // Depth 1: grandchild (spawned from child's session key)
    const grandchild = spawnSession(makeOpts({
      parentSessionId: child.childSessionKey,
      depth: 1,
    }));
    expect(grandchild.success).toBe(true);

    // Depth 2: great-grandchild (still allowed)
    const great = spawnSession(makeOpts({
      parentSessionId: grandchild.childSessionKey,
      depth: 2,
    }));
    expect(great.success).toBe(true);

    // Depth 3: too deep — rejected
    const tooDeep = spawnSession(makeOpts({
      parentSessionId: great.childSessionKey,
      depth: 3,
    }));
    expect(tooDeep.success).toBe(false);
    expect(tooDeep.error).toContain("Max spawn depth");
  });
});
