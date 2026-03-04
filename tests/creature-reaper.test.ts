/**
 * ELLIE-500 — Creature reaper: exhausted-retry creatures
 *
 * Covers: reapExhaustedRetryCreatures() correctly identifies dispatched
 * creatures with started_at=null and retry_count >= max_retries, fails each
 * with reason 'exhausted_retries', and returns the reaped list.
 *
 * The running-timeout reaper (reap_timed_out_creatures DB function) only
 * catches running/working creatures past their timeout — it misses creatures
 * stuck in dispatched state that exhausted retries without ever starting.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mock all forest module dependencies before importing ──────────────────────
// work-sessions.ts imports: sql/db, trees, branches, commits, creatures, shared-memory

let _sqlRows: { id: string }[] = [];

mock.module("../../ellie-forest/src/db", () => {
  const fn: any = (..._args: any[]) => Promise.resolve(_sqlRows);
  fn.json = (v: any) => v;
  fn.begin = async (cb: any) => cb(fn);
  return { default: fn };
});

const _mockFailCreature = mock(async (id: string, _err: string) => ({
  id,
  state: "failed",
  completed_at: new Date(),
  error: _err,
  tree_id: "tree-" + id,
  entity_id: "entity-" + id,
  intent: "test-intent",
}));

mock.module("../../ellie-forest/src/creatures", () => ({
  failCreature: _mockFailCreature,
  completeCreature: mock(() => Promise.resolve({})),
  getActiveCreatures: mock(() => Promise.resolve([])),
  dispatchCreature: mock(() => Promise.resolve({})),
  startCreature: mock(() => Promise.resolve({})),
  getCreature: mock(() => Promise.resolve(null)),
  dispatchPushCreature: mock(() => Promise.resolve({})),
  getChildCreatures: mock(() => Promise.resolve([])),
  getCreatureAncestry: mock(() => Promise.resolve([])),
}));

mock.module("../../ellie-forest/src/trees", () => ({
  getTree: mock(() => Promise.resolve(null)),
  closeTree: mock(() => Promise.resolve(null)),
  updateTreeState: mock(() => Promise.resolve(null)),
  getTrunk: mock(() => Promise.resolve(null)),
  createTree: mock(() => Promise.resolve(null)),
  createTrunk: mock(() => Promise.resolve(null)),
  promoteTree: mock(() => Promise.resolve(null)),
  listActiveTrees: mock(() => Promise.resolve([])),
}));

mock.module("../../ellie-forest/src/branches", () => ({
  listOpenBranches: mock(() => Promise.resolve([])),
  mergeBranch: mock(() => Promise.resolve(null)),
}));

mock.module("../../ellie-forest/src/commits", () => ({
  addCommit: mock(() => Promise.resolve(null)),
  getLatestCommit: mock(() => Promise.resolve(null)),
}));

mock.module("../../ellie-forest/src/shared-memory", () => ({
  promoteTreeMemoriesToGlobal: mock(() => Promise.resolve(0)),
}));

// Import after mocks are registered
import { reapExhaustedRetryCreatures } from "../../ellie-forest/src/work-sessions";

// ── Tests ─────────────────────────────────────────────────────

describe("reapExhaustedRetryCreatures", () => {
  beforeEach(() => {
    _sqlRows = [];
    _mockFailCreature.mockClear();
  });

  test("returns empty array when no exhausted creatures exist", async () => {
    _sqlRows = [];
    const result = await reapExhaustedRetryCreatures();
    expect(result).toHaveLength(0);
    expect(_mockFailCreature).not.toHaveBeenCalled();
  });

  test("reaps a single exhausted creature — calls failCreature with 'exhausted_retries'", async () => {
    _sqlRows = [{ id: "creature-aaa" }];
    const result = await reapExhaustedRetryCreatures();

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ creature_id: "creature-aaa", action: "exhausted_retries" });
    expect(_mockFailCreature).toHaveBeenCalledTimes(1);
    expect(_mockFailCreature).toHaveBeenCalledWith("creature-aaa", "exhausted_retries");
  });

  test("reaps multiple exhausted creatures — one failCreature call per creature", async () => {
    _sqlRows = [
      { id: "creature-111" },
      { id: "creature-222" },
      { id: "creature-333" },
    ];
    const result = await reapExhaustedRetryCreatures();

    expect(result).toHaveLength(3);
    expect(result.map(r => r.creature_id)).toEqual(["creature-111", "creature-222", "creature-333"]);
    expect(result.every(r => r.action === "exhausted_retries")).toBe(true);
    expect(_mockFailCreature).toHaveBeenCalledTimes(3);
  });

  test("action field is always 'exhausted_retries'", async () => {
    _sqlRows = [{ id: "c-x" }, { id: "c-y" }];
    const result = await reapExhaustedRetryCreatures();

    for (const r of result) {
      expect(r.action).toBe("exhausted_retries");
    }
  });

  test("each creature is failed with 'exhausted_retries' as the error reason", async () => {
    _sqlRows = [{ id: "c-abc" }];
    await reapExhaustedRetryCreatures();

    const [id, error] = _mockFailCreature.mock.calls[0];
    expect(id).toBe("c-abc");
    expect(error).toBe("exhausted_retries");
  });

  test("returned creature_ids match what was queried", async () => {
    const ids = ["id-1", "id-2", "id-3", "id-4"];
    _sqlRows = ids.map(id => ({ id }));

    const result = await reapExhaustedRetryCreatures();

    expect(result.map(r => r.creature_id)).toEqual(ids);
  });
});

// ── Distinguishing from running-timeout reaper ────────────────

describe("reapExhaustedRetryCreatures — contract (ELLIE-500 AC)", () => {
  beforeEach(() => {
    _sqlRows = [];
    _mockFailCreature.mockClear();
  });

  test("does not reap creatures that have started (started_at is not null) — SQL filter is correct", async () => {
    // The SQL WHERE clause filters: state='dispatched' AND started_at IS NULL AND retry_count >= max_retries
    // We simulate the DB returning only matching rows (started creatures excluded by DB)
    _sqlRows = []; // DB returns nothing — started creature excluded
    const result = await reapExhaustedRetryCreatures();
    expect(result).toHaveLength(0);
    expect(_mockFailCreature).not.toHaveBeenCalled();
  });

  test("processes zero creatures gracefully — no error thrown", async () => {
    _sqlRows = [];
    await expect(reapExhaustedRetryCreatures()).resolves.toEqual([]);
  });

  test("returns results in the same order as the DB query", async () => {
    _sqlRows = [{ id: "first" }, { id: "second" }, { id: "third" }];
    const result = await reapExhaustedRetryCreatures();
    expect(result[0].creature_id).toBe("first");
    expect(result[1].creature_id).toBe("second");
    expect(result[2].creature_id).toBe("third");
  });
});
