/**
 * ELLIE-519 — Async checkpoint saves with error handling
 *
 * Covers:
 * - saveCheckpoint: DB primary write, disk fallback on DB error, both-fail resilience
 * - loadCheckpoint: DB first, disk fallback, stale checkpoint discard
 * - deleteCheckpoint: DB + disk cleanup
 * - canResume: in-memory + persisted checkpoint lookup
 * - initCheckpointStore: module-level Supabase init
 * - In-memory registry: set/get/remove/getAll/clear
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, readFile, mkdir, unlink } from "fs/promises";
import { join } from "path";

import {
  saveCheckpoint,
  loadCheckpoint,
  deleteCheckpoint,
  initCheckpointStore,
  setActiveCheckpoint,
  getActiveCheckpoint,
  removeActiveCheckpoint,
  getAllActiveCheckpoints,
  _clearActiveCheckpoints,
  _getSupabaseClient,
  canResume,
  type PipelineCheckpoint,
} from "../src/pipeline-state.ts";

// ── Test Helpers ────────────────────────────────────────────

const CACHE_DIR = join(process.cwd(), ".cache");

function diskPath(pipelineId: string): string {
  return join(CACHE_DIR, `pipeline-${pipelineId}.json`);
}

let _idCounter = 0;
function uniqueId(): string {
  return `test-519-${Date.now()}-${++_idCounter}`;
}

function makeCheckpoint(overrides: Partial<PipelineCheckpoint> = {}): PipelineCheckpoint {
  return {
    pipelineId: uniqueId(),
    originalMessage: "test message",
    steps: [{ agent_name: "dev", instruction: "do something" }],
    nextStepIndex: 0,
    completedSteps: [],
    lastOutput: null,
    artifacts: {
      total_duration_ms: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost_usd: 0,
    },
    channel: "test",
    updatedAt: Date.now(),
    ...overrides,
  };
}

/** Tracks upsert/select/delete calls on the mock Supabase client. */
interface MockCalls {
  upsert: { table: string; data: any }[];
  select: { table: string }[];
  delete: { table: string; id: string }[];
}

/** Create a mock Supabase client with configurable behavior. */
function mockSupabase(opts: {
  upsertError?: any;
  selectData?: any;
  selectError?: any;
  deleteError?: any;
  upsertThrow?: boolean;
  selectThrow?: boolean;
  deleteThrow?: boolean;
} = {}): any & { _calls: MockCalls } {
  const _calls: MockCalls = { upsert: [], select: [], delete: [] };

  const client: any = {
    from: (table: string) => ({
      upsert: (data: any) => {
        _calls.upsert.push({ table, data });
        if (opts.upsertThrow) throw new Error("DB connection lost");
        return Promise.resolve({ error: opts.upsertError || null });
      },
      select: (columns: string) => ({
        eq: (_col: string, _val: string) => ({
          single: () => {
            _calls.select.push({ table });
            if (opts.selectThrow) throw new Error("DB connection lost");
            return Promise.resolve({
              data: opts.selectData ?? null,
              error: opts.selectError || null,
            });
          },
        }),
      }),
      delete: () => ({
        eq: (_col: string, val: string) => {
          _calls.delete.push({ table, id: val });
          if (opts.deleteThrow) throw new Error("DB connection lost");
          return Promise.resolve({ error: opts.deleteError || null });
        },
      }),
    }),
    _calls,
  };

  return client;
}

/** Check if a file exists on disk. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Read and parse a checkpoint from disk. */
async function readDiskCheckpoint(pipelineId: string): Promise<PipelineCheckpoint | null> {
  try {
    const raw = await readFile(diskPath(pipelineId), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Setup / Teardown ────────────────────────────────────────

const createdPipelineIds: string[] = [];

beforeEach(() => {
  _clearActiveCheckpoints();
  initCheckpointStore(null);
});

afterEach(async () => {
  // Clean up disk files created during tests
  for (const id of createdPipelineIds) {
    await unlink(diskPath(id)).catch(() => {});
  }
  createdPipelineIds.length = 0;
});

// Helper that tracks cleanup
function trackedCheckpoint(overrides: Partial<PipelineCheckpoint> = {}): PipelineCheckpoint {
  const cp = makeCheckpoint(overrides);
  createdPipelineIds.push(cp.pipelineId);
  return cp;
}

// ────────────────────────────────────────────────────────────
// initCheckpointStore
// ────────────────────────────────────────────────────────────

describe("initCheckpointStore", () => {
  test("sets the Supabase client", () => {
    const client = mockSupabase();
    initCheckpointStore(client);
    expect(_getSupabaseClient()).toBe(client);
  });

  test("accepts null for disk-only mode", () => {
    initCheckpointStore(null);
    expect(_getSupabaseClient()).toBeNull();
  });

  test("replaces a previous client", () => {
    const client1 = mockSupabase();
    const client2 = mockSupabase();
    initCheckpointStore(client1);
    initCheckpointStore(client2);
    expect(_getSupabaseClient()).toBe(client2);
  });
});

// ────────────────────────────────────────────────────────────
// saveCheckpoint
// ────────────────────────────────────────────────────────────

describe("saveCheckpoint", () => {
  test("saves to DB when Supabase is available", async () => {
    const client = mockSupabase();
    initCheckpointStore(client);
    const cp = trackedCheckpoint();

    await saveCheckpoint(cp);

    // DB was called
    expect(client._calls.upsert.length).toBe(1);
    expect(client._calls.upsert[0].table).toBe("pipeline_checkpoints");
    expect(client._calls.upsert[0].data.pipeline_id).toBe(cp.pipelineId);
    expect(client._calls.upsert[0].data.checkpoint_data).toBe(cp);

    // Disk should NOT have been written (DB succeeded)
    expect(await fileExists(diskPath(cp.pipelineId))).toBe(false);
  });

  test("falls back to disk when DB upsert returns error", async () => {
    const client = mockSupabase({ upsertError: { message: "relation does not exist" } });
    initCheckpointStore(client);
    const cp = trackedCheckpoint();

    await saveCheckpoint(cp);

    // DB was attempted
    expect(client._calls.upsert.length).toBe(1);

    // Disk fallback was written
    const diskData = await readDiskCheckpoint(cp.pipelineId);
    expect(diskData).toBeTruthy();
    expect(diskData!.pipelineId).toBe(cp.pipelineId);
  });

  test("falls back to disk when DB throws", async () => {
    const client = mockSupabase({ upsertThrow: true });
    initCheckpointStore(client);
    const cp = trackedCheckpoint();

    await saveCheckpoint(cp);

    const diskData = await readDiskCheckpoint(cp.pipelineId);
    expect(diskData).toBeTruthy();
    expect(diskData!.pipelineId).toBe(cp.pipelineId);
  });

  test("writes to disk when no Supabase client", async () => {
    initCheckpointStore(null);
    const cp = trackedCheckpoint();

    await saveCheckpoint(cp);

    const diskData = await readDiskCheckpoint(cp.pipelineId);
    expect(diskData).toBeTruthy();
    expect(diskData!.pipelineId).toBe(cp.pipelineId);
  });

  test("updates updatedAt timestamp", async () => {
    initCheckpointStore(null);
    const cp = trackedCheckpoint({ updatedAt: 0 });
    const before = Date.now();

    await saveCheckpoint(cp);

    expect(cp.updatedAt).toBeGreaterThanOrEqual(before);
  });

  test("never throws even on total failure", async () => {
    const client = mockSupabase({ upsertThrow: true });
    initCheckpointStore(client);
    // Use null byte in pipelineId to cause disk write failure
    const cp = trackedCheckpoint({ pipelineId: "/\0invalid" });

    // Should not throw
    await expect(saveCheckpoint(cp)).resolves.toBeUndefined();
  });

  test("upserts correctly on repeated saves (step progression)", async () => {
    const client = mockSupabase();
    initCheckpointStore(client);
    const cp = trackedCheckpoint();

    await saveCheckpoint(cp);

    cp.nextStepIndex = 1;
    cp.completedSteps = [{
      step_index: 0, agent_name: "dev", output: "done",
      duration_ms: 100, input_tokens: 50, output_tokens: 50,
      cost_usd: 0.01, execution_type: "heavy", session_id: "s1",
    }];
    await saveCheckpoint(cp);

    expect(client._calls.upsert.length).toBe(2);
    expect(client._calls.upsert[1].data.checkpoint_data.nextStepIndex).toBe(1);
    expect(client._calls.upsert[1].data.checkpoint_data.completedSteps).toHaveLength(1);
  });

  test("includes pipeline_id and updated_at in DB payload", async () => {
    const client = mockSupabase();
    initCheckpointStore(client);
    const cp = trackedCheckpoint();

    await saveCheckpoint(cp);

    const payload = client._calls.upsert[0].data;
    expect(payload.pipeline_id).toBe(cp.pipelineId);
    expect(payload.updated_at).toBeTruthy();
    expect(payload.checkpoint_data).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────
// loadCheckpoint
// ────────────────────────────────────────────────────────────

describe("loadCheckpoint", () => {
  test("loads from DB when available", async () => {
    const cp = makeCheckpoint({ updatedAt: Date.now() });
    const client = mockSupabase({
      selectData: { checkpoint_data: cp },
    });
    initCheckpointStore(client);

    const loaded = await loadCheckpoint(cp.pipelineId);

    expect(loaded).toBeTruthy();
    expect(loaded!.pipelineId).toBe(cp.pipelineId);
    expect(client._calls.select.length).toBe(1);
  });

  test("falls back to disk when DB returns no data", async () => {
    const cp = trackedCheckpoint({ updatedAt: Date.now() });
    const client = mockSupabase({ selectData: null });
    initCheckpointStore(client);

    // Write to disk
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(diskPath(cp.pipelineId), JSON.stringify(cp), "utf-8");

    const loaded = await loadCheckpoint(cp.pipelineId);

    expect(loaded).toBeTruthy();
    expect(loaded!.pipelineId).toBe(cp.pipelineId);
  });

  test("falls back to disk when DB throws", async () => {
    const cp = trackedCheckpoint({ updatedAt: Date.now() });
    const client = mockSupabase({ selectThrow: true });
    initCheckpointStore(client);

    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(diskPath(cp.pipelineId), JSON.stringify(cp), "utf-8");

    const loaded = await loadCheckpoint(cp.pipelineId);

    expect(loaded).toBeTruthy();
    expect(loaded!.pipelineId).toBe(cp.pipelineId);
  });

  test("discards stale DB checkpoint (>1 hour old)", async () => {
    const staleTime = Date.now() - 3_700_000; // >1 hour
    const cp = makeCheckpoint({ updatedAt: staleTime });
    const client = mockSupabase({
      selectData: { checkpoint_data: cp },
    });
    initCheckpointStore(client);

    const loaded = await loadCheckpoint(cp.pipelineId);
    expect(loaded).toBeNull();
  });

  test("discards stale disk checkpoint (>1 hour old)", async () => {
    initCheckpointStore(null);
    const staleTime = Date.now() - 3_700_000;
    const cp = trackedCheckpoint({ updatedAt: staleTime });

    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(diskPath(cp.pipelineId), JSON.stringify(cp), "utf-8");

    const loaded = await loadCheckpoint(cp.pipelineId);
    expect(loaded).toBeNull();
  });

  test("returns null when checkpoint doesn't exist anywhere", async () => {
    initCheckpointStore(null);
    const loaded = await loadCheckpoint("nonexistent-pipeline-id");
    expect(loaded).toBeNull();
  });

  test("returns null when DB returns no data and no disk file", async () => {
    const client = mockSupabase({ selectData: null });
    initCheckpointStore(client);
    const loaded = await loadCheckpoint("nonexistent-pipeline-id");
    expect(loaded).toBeNull();
  });

  test("preserves all fields from DB checkpoint", async () => {
    const cp = makeCheckpoint({
      updatedAt: Date.now(),
      nextStepIndex: 2,
      completedSteps: [
        { step_index: 0, agent_name: "dev", output: "s0", duration_ms: 100, input_tokens: 50, output_tokens: 50, cost_usd: 0.01, execution_type: "heavy", session_id: "s1" },
        { step_index: 1, agent_name: "research", output: "s1", duration_ms: 200, input_tokens: 100, output_tokens: 100, cost_usd: 0.02, execution_type: "light", session_id: "s2" },
      ],
      lastOutput: "step1 output",
      failureError: "some error",
      failedStepIndex: 2,
      runId: "run-abc",
    });
    const client = mockSupabase({
      selectData: { checkpoint_data: cp },
    });
    initCheckpointStore(client);

    const loaded = await loadCheckpoint(cp.pipelineId);

    expect(loaded!.nextStepIndex).toBe(2);
    expect(loaded!.completedSteps).toHaveLength(2);
    expect(loaded!.lastOutput).toBe("step1 output");
    expect(loaded!.failureError).toBe("some error");
    expect(loaded!.failedStepIndex).toBe(2);
    expect(loaded!.runId).toBe("run-abc");
  });

  test("accepts checkpoint right at 1 hour boundary", async () => {
    const justUnder = Date.now() - 3_500_000; // ~58 minutes
    const cp = makeCheckpoint({ updatedAt: justUnder });
    const client = mockSupabase({
      selectData: { checkpoint_data: cp },
    });
    initCheckpointStore(client);

    const loaded = await loadCheckpoint(cp.pipelineId);
    expect(loaded).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────
// deleteCheckpoint
// ────────────────────────────────────────────────────────────

describe("deleteCheckpoint", () => {
  test("deletes from both DB and disk", async () => {
    const cp = trackedCheckpoint();
    const client = mockSupabase();
    initCheckpointStore(client);

    // Write to disk first
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(diskPath(cp.pipelineId), JSON.stringify(cp), "utf-8");

    await deleteCheckpoint(cp.pipelineId);

    // DB delete was called
    expect(client._calls.delete.length).toBe(1);
    expect(client._calls.delete[0].table).toBe("pipeline_checkpoints");

    // Disk file is gone
    expect(await fileExists(diskPath(cp.pipelineId))).toBe(false);
  });

  test("handles DB delete error gracefully (does not throw)", async () => {
    const client = mockSupabase({ deleteError: { message: "permission denied" } });
    initCheckpointStore(client);

    await expect(deleteCheckpoint("some-pipeline")).resolves.toBeUndefined();
  });

  test("handles DB delete throw gracefully", async () => {
    const client = mockSupabase({ deleteThrow: true });
    initCheckpointStore(client);

    await expect(deleteCheckpoint("some-pipeline")).resolves.toBeUndefined();
  });

  test("handles missing disk file gracefully", async () => {
    initCheckpointStore(null);
    await expect(deleteCheckpoint("nonexistent-pipeline")).resolves.toBeUndefined();
  });

  test("deletes DB even when disk file does not exist", async () => {
    const client = mockSupabase();
    initCheckpointStore(client);

    await deleteCheckpoint("pipeline-no-disk-file");

    expect(client._calls.delete.length).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────
// In-Memory Registry
// ────────────────────────────────────────────────────────────

describe("in-memory registry", () => {
  test("setActiveCheckpoint stores checkpoint", () => {
    const cp = makeCheckpoint();
    setActiveCheckpoint(cp);
    expect(getActiveCheckpoint(cp.pipelineId)).toBe(cp);
  });

  test("getActiveCheckpoint returns null for unknown ID", () => {
    expect(getActiveCheckpoint("unknown")).toBeNull();
  });

  test("removeActiveCheckpoint removes stored checkpoint", () => {
    const cp = makeCheckpoint();
    setActiveCheckpoint(cp);
    removeActiveCheckpoint(cp.pipelineId);
    expect(getActiveCheckpoint(cp.pipelineId)).toBeNull();
  });

  test("getAllActiveCheckpoints returns all stored checkpoints", () => {
    const cp1 = makeCheckpoint({ pipelineId: "p1" });
    const cp2 = makeCheckpoint({ pipelineId: "p2" });
    setActiveCheckpoint(cp1);
    setActiveCheckpoint(cp2);
    const all = getAllActiveCheckpoints();
    expect(all).toHaveLength(2);
    expect(all.map(c => c.pipelineId).sort()).toEqual(["p1", "p2"]);
  });

  test("_clearActiveCheckpoints empties the registry", () => {
    setActiveCheckpoint(makeCheckpoint({ pipelineId: "p1" }));
    setActiveCheckpoint(makeCheckpoint({ pipelineId: "p2" }));
    _clearActiveCheckpoints();
    expect(getAllActiveCheckpoints()).toHaveLength(0);
  });

  test("setActiveCheckpoint overwrites existing entry", () => {
    const cp1 = makeCheckpoint({ pipelineId: "same-id", nextStepIndex: 0 });
    const cp2 = makeCheckpoint({ pipelineId: "same-id", nextStepIndex: 3 });
    setActiveCheckpoint(cp1);
    setActiveCheckpoint(cp2);
    expect(getActiveCheckpoint("same-id")!.nextStepIndex).toBe(3);
    expect(getAllActiveCheckpoints()).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────
// canResume
// ────────────────────────────────────────────────────────────

describe("canResume", () => {
  test("returns resumable when active checkpoint has remaining steps", async () => {
    const cp = makeCheckpoint({
      pipelineId: "resume-test",
      steps: [
        { agent_name: "dev", instruction: "step 1" },
        { agent_name: "research", instruction: "step 2" },
      ],
      nextStepIndex: 1,
      completedSteps: [{
        step_index: 0, agent_name: "dev", output: "done",
        duration_ms: 100, input_tokens: 50, output_tokens: 50,
        cost_usd: 0.01, execution_type: "heavy", session_id: "s1",
      }],
    });
    setActiveCheckpoint(cp);

    const result = await canResume("resume-test");

    expect(result.resumable).toBe(true);
    expect(result.stepsRemaining).toBe(1);
    expect(result.stepsCompleted).toBe(1);
    expect(result.checkpoint).toBe(cp);
  });

  test("returns not resumable when all steps completed", async () => {
    const cp = makeCheckpoint({
      pipelineId: "done-test",
      steps: [{ agent_name: "dev", instruction: "step 1" }],
      nextStepIndex: 1,
      completedSteps: [{
        step_index: 0, agent_name: "dev", output: "done",
        duration_ms: 100, input_tokens: 50, output_tokens: 50,
        cost_usd: 0.01, execution_type: "heavy", session_id: "s1",
      }],
    });
    setActiveCheckpoint(cp);

    const result = await canResume("done-test");

    expect(result.resumable).toBe(false);
    expect(result.stepsRemaining).toBe(0);
  });

  test("returns not resumable when checkpoint not found", async () => {
    initCheckpointStore(null);
    const result = await canResume("nonexistent");

    expect(result.resumable).toBe(false);
    expect(result.checkpoint).toBeNull();
    expect(result.stepsRemaining).toBe(0);
    expect(result.stepsCompleted).toBe(0);
  });

  test("prefers in-memory checkpoint over DB", async () => {
    const memCp = makeCheckpoint({
      pipelineId: "mem-vs-db",
      nextStepIndex: 2,
      steps: [
        { agent_name: "dev", instruction: "s1" },
        { agent_name: "research", instruction: "s2" },
        { agent_name: "critic", instruction: "s3" },
      ],
    });
    setActiveCheckpoint(memCp);

    // DB has a different version
    const dbCp = makeCheckpoint({
      pipelineId: "mem-vs-db",
      nextStepIndex: 1,
      updatedAt: Date.now(),
    });
    const client = mockSupabase({ selectData: { checkpoint_data: dbCp } });
    initCheckpointStore(client);

    const result = await canResume("mem-vs-db");

    // Should use in-memory (nextStepIndex=2), not DB (nextStepIndex=1)
    expect(result.checkpoint!.nextStepIndex).toBe(2);
    expect(result.stepsRemaining).toBe(1);
  });

  test("loads from DB when not in memory", async () => {
    const cp = makeCheckpoint({
      pipelineId: "db-resume",
      steps: [
        { agent_name: "dev", instruction: "step 1" },
        { agent_name: "research", instruction: "step 2" },
      ],
      nextStepIndex: 1,
      updatedAt: Date.now(),
    });
    const client = mockSupabase({
      selectData: { checkpoint_data: cp },
    });
    initCheckpointStore(client);

    const result = await canResume("db-resume");

    expect(result.resumable).toBe(true);
    expect(result.stepsRemaining).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────
// Integration: save → load round-trip
// ────────────────────────────────────────────────────────────

describe("save → load round-trip", () => {
  test("disk round-trip preserves all fields", async () => {
    initCheckpointStore(null);
    const cp = trackedCheckpoint({
      nextStepIndex: 1,
      completedSteps: [{
        step_index: 0, agent_name: "dev", output: "result",
        duration_ms: 500, input_tokens: 100, output_tokens: 200,
        cost_usd: 0.05, execution_type: "heavy", session_id: "sess1",
      }],
      lastOutput: "previous result",
      failureError: "some error",
      failedStepIndex: 1,
      runId: "run-123",
      artifacts: {
        total_duration_ms: 500,
        total_input_tokens: 100,
        total_output_tokens: 200,
        total_cost_usd: 0.05,
      },
    });

    await saveCheckpoint(cp);
    const loaded = await loadCheckpoint(cp.pipelineId);

    expect(loaded).toBeTruthy();
    expect(loaded!.pipelineId).toBe(cp.pipelineId);
    expect(loaded!.nextStepIndex).toBe(1);
    expect(loaded!.completedSteps).toHaveLength(1);
    expect(loaded!.completedSteps[0].agent_name).toBe("dev");
    expect(loaded!.lastOutput).toBe("previous result");
    expect(loaded!.failureError).toBe("some error");
    expect(loaded!.failedStepIndex).toBe(1);
    expect(loaded!.runId).toBe("run-123");
    expect(loaded!.artifacts.total_cost_usd).toBe(0.05);
    expect(loaded!.artifacts.total_duration_ms).toBe(500);
  });

  test("DB round-trip preserves checkpoint via stateful mock", async () => {
    const stored: Record<string, any> = {};
    const client: any = {
      from: () => ({
        upsert: (data: any) => {
          stored[data.pipeline_id] = data;
          return Promise.resolve({ error: null });
        },
        select: () => ({
          eq: (_col: string, val: string) => ({
            single: () => Promise.resolve({
              data: stored[val] || null,
              error: stored[val] ? null : { code: "PGRST116" },
            }),
          }),
        }),
        delete: () => ({
          eq: (_col: string, val: string) => {
            delete stored[val];
            return Promise.resolve({ error: null });
          },
        }),
      }),
    };
    initCheckpointStore(client);

    const cp = makeCheckpoint({
      pipelineId: "db-roundtrip",
      nextStepIndex: 2,
      updatedAt: Date.now(),
    });

    await saveCheckpoint(cp);
    const loaded = await loadCheckpoint(cp.pipelineId);

    expect(loaded).toBeTruthy();
    expect(loaded!.pipelineId).toBe("db-roundtrip");
    expect(loaded!.nextStepIndex).toBe(2);
  });

  test("save → delete → load returns null (stateful mock)", async () => {
    const stored: Record<string, any> = {};
    const client: any = {
      from: () => ({
        upsert: (data: any) => {
          stored[data.pipeline_id] = data;
          return Promise.resolve({ error: null });
        },
        select: () => ({
          eq: (_col: string, val: string) => ({
            single: () => Promise.resolve({
              data: stored[val] || null,
              error: stored[val] ? null : { code: "PGRST116" },
            }),
          }),
        }),
        delete: () => ({
          eq: (_col: string, val: string) => {
            delete stored[val];
            return Promise.resolve({ error: null });
          },
        }),
      }),
    };
    initCheckpointStore(client);
    const cp = trackedCheckpoint({ updatedAt: Date.now() });

    await saveCheckpoint(cp);
    await deleteCheckpoint(cp.pipelineId);
    const loaded = await loadCheckpoint(cp.pipelineId);

    expect(loaded).toBeNull();
  });

  test("disk save → disk delete → disk load returns null", async () => {
    initCheckpointStore(null);
    const cp = trackedCheckpoint();

    await saveCheckpoint(cp);
    expect(await fileExists(diskPath(cp.pipelineId))).toBe(true);

    await deleteCheckpoint(cp.pipelineId);
    expect(await fileExists(diskPath(cp.pipelineId))).toBe(false);

    const loaded = await loadCheckpoint(cp.pipelineId);
    expect(loaded).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// DB-failure fallback chain
// ────────────────────────────────────────────────────────────

describe("DB-failure fallback chain", () => {
  test("save to DB fails → disk → load from DB fails → disk returns it", async () => {
    // Save: DB fails, falls back to disk
    const saveMock = mockSupabase({ upsertThrow: true, selectThrow: true });
    initCheckpointStore(saveMock);
    const cp = trackedCheckpoint();

    await saveCheckpoint(cp);

    // Checkpoint should be on disk
    expect(await fileExists(diskPath(cp.pipelineId))).toBe(true);

    // Load: DB fails, falls back to disk
    const loaded = await loadCheckpoint(cp.pipelineId);
    expect(loaded).toBeTruthy();
    expect(loaded!.pipelineId).toBe(cp.pipelineId);
  });

  test("complete failure chain: DB save fails + disk save succeeds, DB load fails + disk load succeeds", async () => {
    const client = mockSupabase({ upsertError: { message: "timeout" }, selectError: { message: "timeout" } });
    initCheckpointStore(client);
    const cp = trackedCheckpoint();

    // Save: DB error → disk fallback
    await saveCheckpoint(cp);
    expect(await fileExists(diskPath(cp.pipelineId))).toBe(true);

    // Load: DB error → disk fallback
    const loaded = await loadCheckpoint(cp.pipelineId);
    expect(loaded).toBeTruthy();
    expect(loaded!.pipelineId).toBe(cp.pipelineId);
  });
});
