/**
 * ELLIE-954 — Tests for spawn-registry-db.ts
 *
 * Tests the DB persistence layer for spawn records.
 * Uses the real Forest database (ellie-forest) — tests clean up after themselves.
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import sql from "../../ellie-forest/src/db.ts";
import {
  persistSpawnRecord,
  updateSpawnState,
  pruneDbSpawnRecords,
  loadActiveSpawnRecords,
  recoverStaleSpawns,
} from "../src/spawn-registry-db.ts";
import type { SpawnRecord } from "../src/types/session-spawn.ts";

// ── Helpers ──────────────────────────────────────────────────

function makeRecord(overrides: Partial<SpawnRecord> = {}): SpawnRecord {
  const id = crypto.randomUUID();
  return {
    id,
    parentSessionId: "parent-session-1",
    parentAgentName: "dev",
    childSessionId: `child-${id}`,
    childSessionKey: `agent:research:subagent:${id}`,
    targetAgentName: "research",
    task: "Test task",
    state: "pending",
    arcMode: "inherit",
    arcId: null,
    deliveryContext: null,
    threadBound: false,
    workItemId: null,
    createdAt: Date.now(),
    endedAt: null,
    resultText: null,
    error: null,
    timeoutSeconds: 300,
    depth: 0,
    ...overrides,
  };
}

async function cleanTable() {
  await sql`DELETE FROM agent_spawn_records WHERE parent_session_id LIKE 'test-%' OR parent_session_id = 'parent-session-1'`;
}

beforeEach(async () => {
  await cleanTable();
});

afterAll(async () => {
  await cleanTable();
  await sql.end();
});

// ── persistSpawnRecord ───────────────────────────────────────

describe("persistSpawnRecord", () => {
  test("inserts a record into the database", async () => {
    const record = makeRecord({ parentSessionId: "test-persist-1" });
    await persistSpawnRecord(record);

    const [row] = await sql<{ id: string; state: string; target_agent_name: string }[]>`
      SELECT id, state, target_agent_name FROM agent_spawn_records WHERE id = ${record.id}::uuid
    `;
    expect(row).toBeDefined();
    expect(row.state).toBe("pending");
    expect(row.target_agent_name).toBe("research");
  });

  test("stores delivery context as JSONB", async () => {
    const record = makeRecord({
      parentSessionId: "test-persist-2",
      deliveryContext: { channel: "discord", threadId: "t-123" },
    });
    await persistSpawnRecord(record);

    const [row] = await sql<{ delivery_context: { channel: string; threadId: string } }[]>`
      SELECT delivery_context FROM agent_spawn_records WHERE id = ${record.id}::uuid
    `;
    expect(row.delivery_context.channel).toBe("discord");
    expect(row.delivery_context.threadId).toBe("t-123");
  });

  test("is idempotent on duplicate child_session_key", async () => {
    const record = makeRecord({ parentSessionId: "test-persist-3" });
    await persistSpawnRecord(record);
    await persistSpawnRecord(record); // should not throw

    const rows = await sql<{ id: string }[]>`
      SELECT id FROM agent_spawn_records WHERE child_session_key = ${record.childSessionKey}
    `;
    expect(rows).toHaveLength(1);
  });
});

// ── updateSpawnState ─────────────────────────────────────────

describe("updateSpawnState", () => {
  test("transitions state to running", async () => {
    const record = makeRecord({ parentSessionId: "test-update-1" });
    await persistSpawnRecord(record);

    await updateSpawnState(record.id, "running", { childSessionId: "real-session-1" });

    const [row] = await sql<{ state: string; child_session_id: string }[]>`
      SELECT state, child_session_id FROM agent_spawn_records WHERE id = ${record.id}::uuid
    `;
    expect(row.state).toBe("running");
    expect(row.child_session_id).toBe("real-session-1");
  });

  test("transitions state to completed with result text", async () => {
    const record = makeRecord({ parentSessionId: "test-update-2" });
    await persistSpawnRecord(record);

    const endedAt = Date.now();
    await updateSpawnState(record.id, "completed", {
      resultText: "Research complete",
      endedAt,
    });

    const [row] = await sql<{ state: string; result_text: string; ended_at: Date }[]>`
      SELECT state, result_text, ended_at FROM agent_spawn_records WHERE id = ${record.id}::uuid
    `;
    expect(row.state).toBe("completed");
    expect(row.result_text).toBe("Research complete");
    expect(row.ended_at).toBeTruthy();
  });

  test("transitions state to failed with error", async () => {
    const record = makeRecord({ parentSessionId: "test-update-3" });
    await persistSpawnRecord(record);

    await updateSpawnState(record.id, "failed", {
      error: "Agent crashed",
      endedAt: Date.now(),
    });

    const [row] = await sql<{ state: string; error: string }[]>`
      SELECT state, error FROM agent_spawn_records WHERE id = ${record.id}::uuid
    `;
    expect(row.state).toBe("failed");
    expect(row.error).toBe("Agent crashed");
  });
});

// ── loadActiveSpawnRecords ───────────────────────────────────

describe("loadActiveSpawnRecords", () => {
  test("loads pending and running records", async () => {
    const r1 = makeRecord({ parentSessionId: "test-load-1", state: "pending" as const });
    const r2 = makeRecord({ parentSessionId: "test-load-1", state: "pending" as const });
    await persistSpawnRecord(r1);
    await persistSpawnRecord(r2);
    // Update r2 to running
    await updateSpawnState(r2.id, "running");

    const records = await loadActiveSpawnRecords();
    const testRecords = records.filter((r) => r.parentSessionId === "test-load-1");
    expect(testRecords).toHaveLength(2);
    expect(testRecords.map((r) => r.state).sort()).toEqual(["pending", "running"]);
  });

  test("does not load completed records", async () => {
    const r1 = makeRecord({ parentSessionId: "test-load-2" });
    await persistSpawnRecord(r1);
    await updateSpawnState(r1.id, "completed", { resultText: "done", endedAt: Date.now() });

    const records = await loadActiveSpawnRecords();
    const testRecords = records.filter((r) => r.parentSessionId === "test-load-2");
    expect(testRecords).toHaveLength(0);
  });

  test("correctly maps row to SpawnRecord", async () => {
    const r1 = makeRecord({
      parentSessionId: "test-load-3",
      targetAgentName: "critic",
      workItemId: "ELLIE-100",
      depth: 1,
      threadBound: true,
    });
    await persistSpawnRecord(r1);

    const records = await loadActiveSpawnRecords();
    const loaded = records.find((r) => r.id === r1.id);
    expect(loaded).toBeDefined();
    expect(loaded!.targetAgentName).toBe("critic");
    expect(loaded!.workItemId).toBe("ELLIE-100");
    expect(loaded!.depth).toBe(1);
    expect(loaded!.threadBound).toBe(true);
    expect(loaded!.arcMode).toBe("inherit");
  });
});

// ── recoverStaleSpawns ───────────────────────────────────────

describe("recoverStaleSpawns", () => {
  test("marks spawns past their timeout as failed", async () => {
    const r1 = makeRecord({
      parentSessionId: "test-recover-1",
      timeoutSeconds: 1, // 1 second timeout
    });
    await persistSpawnRecord(r1);

    // Backdate created_at so it's definitely past timeout
    await sql`
      UPDATE agent_spawn_records SET created_at = NOW() - INTERVAL '10 minutes'
      WHERE id = ${r1.id}::uuid
    `;

    const count = await recoverStaleSpawns();
    expect(count).toBeGreaterThanOrEqual(1);

    const [row] = await sql<{ state: string; error: string }[]>`
      SELECT state, error FROM agent_spawn_records WHERE id = ${r1.id}::uuid
    `;
    expect(row.state).toBe("failed");
    expect(row.error).toContain("Relay restarted");
  });

  test("does not mark fresh spawns as failed", async () => {
    const r1 = makeRecord({
      parentSessionId: "test-recover-2",
      timeoutSeconds: 9999,
    });
    await persistSpawnRecord(r1);

    await recoverStaleSpawns();

    const [row] = await sql<{ state: string }[]>`
      SELECT state FROM agent_spawn_records WHERE id = ${r1.id}::uuid
    `;
    expect(row.state).toBe("pending");
  });
});

// ── pruneDbSpawnRecords ──────────────────────────────────────

describe("pruneDbSpawnRecords", () => {
  test("deletes old completed records", async () => {
    const r1 = makeRecord({ parentSessionId: "test-prune-1" });
    await persistSpawnRecord(r1);
    await updateSpawnState(r1.id, "completed", { resultText: "done", endedAt: Date.now() });

    // Backdate ended_at
    await sql`
      UPDATE agent_spawn_records SET ended_at = NOW() - INTERVAL '20 minutes'
      WHERE id = ${r1.id}::uuid
    `;

    const pruned = await pruneDbSpawnRecords(10 * 60_000);
    expect(pruned).toBeGreaterThanOrEqual(1);

    const rows = await sql<{ id: string }[]>`
      SELECT id FROM agent_spawn_records WHERE id = ${r1.id}::uuid
    `;
    expect(rows).toHaveLength(0);
  });

  test("keeps recent completed records", async () => {
    const r1 = makeRecord({ parentSessionId: "test-prune-2" });
    await persistSpawnRecord(r1);
    await updateSpawnState(r1.id, "completed", { resultText: "done", endedAt: Date.now() });

    const pruned = await pruneDbSpawnRecords(10 * 60_000);
    // Should not be pruned (too recent)
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM agent_spawn_records WHERE id = ${r1.id}::uuid
    `;
    expect(rows).toHaveLength(1);
  });
});
