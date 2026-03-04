/**
 * ELLIE-494 — Creature state machine transitions
 *
 * Verifies that:
 * - startCreature: dispatched → working (throws if not dispatched)
 * - completeCreature: dispatched/working → completed (throws if already completed)
 * - failCreature: dispatched/working → failed (throws if already completed)
 * - each transition emits the correct event kind
 * - dispatchCreature inserts a creature and emits creature.dispatched
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Control knobs ────────────────────────────────────────────

// Rows returned by the SQL mock for creature queries
let _sqlRows: any[] = [];

// Captured emitEvent calls
const _emittedEvents: any[] = [];

// ── SQL mock ─────────────────────────────────────────────────

mock.module("../../ellie-forest/src/db", () => {
  const fn: any = (..._args: any[]) => Promise.resolve(_sqlRows);
  fn.json = (v: any) => v;
  fn.begin = async (cb: any) => cb(fn);
  return { default: fn };
});

// ── Event mock ───────────────────────────────────────────────

mock.module("../../ellie-forest/src/events", () => ({
  emitEvent: mock(async (evt: any) => {
    _emittedEvents.push(evt);
    return { id: "evt-" + Date.now(), ...evt };
  }),
}));

// ── Agent mock (used by dispatchCreature to inherit defaults) ─

mock.module("../../ellie-forest/src/agents", () => ({
  getAgentForEntity: mock(async () => null),
  getAgent: mock(() => Promise.resolve(null)),
  listAgents: mock(() => Promise.resolve([])),
  getAgentTrustLevel: mock(() => Promise.resolve(0.5)),
}));

// ── Import after mocks ────────────────────────────────────────

import {
  startCreature,
  completeCreature,
  failCreature,
  dispatchCreature,
} from "../../ellie-forest/src/creatures";

// ── Helpers ──────────────────────────────────────────────────

function makeCreatureRow(overrides: Partial<any> = {}): any {
  return {
    id: "c-test",
    type: "pull",
    tree_id: "tree-1",
    entity_id: "entity-dev",
    intent: "test intent",
    state: "dispatched",
    dispatched_at: new Date(),
    started_at: null,
    completed_at: null,
    branch_id: null,
    parent_creature_id: null,
    timeout_seconds: 300,
    max_retries: 2,
    retry_count: 0,
    ...overrides,
  };
}

beforeEach(() => {
  _sqlRows = [];
  _emittedEvents.length = 0;
});

// ── startCreature ─────────────────────────────────────────────

describe("startCreature — dispatched → working", () => {
  test("returns working creature when in dispatched state", async () => {
    const row = makeCreatureRow({ state: "working", started_at: new Date() });
    _sqlRows = [row];

    const creature = await startCreature("c-test");

    expect(creature.state).toBe("working");
    expect(creature.id).toBe("c-test");
  });

  test("throws when creature not found or not in dispatched state", async () => {
    _sqlRows = []; // DB returns empty — wrong state or missing

    await expect(startCreature("c-missing")).rejects.toThrow(
      "not found or not in dispatched state",
    );
  });
});

// ── completeCreature ──────────────────────────────────────────

describe("completeCreature — dispatched/working → completed", () => {
  test("returns completed creature", async () => {
    const row = makeCreatureRow({ state: "completed", completed_at: new Date() });
    _sqlRows = [row];

    const creature = await completeCreature("c-test");

    expect(creature.state).toBe("completed");
    expect(creature.id).toBe("c-test");
  });

  test("emits creature.completed event with tree_id, entity_id, creature_id", async () => {
    const row = makeCreatureRow({ state: "completed", completed_at: new Date() });
    _sqlRows = [row];

    await completeCreature("c-test");

    expect(_emittedEvents).toHaveLength(1);
    const evt = _emittedEvents[0];
    expect(evt.kind).toBe("creature.completed");
    expect(evt.tree_id).toBe("tree-1");
    expect(evt.entity_id).toBe("entity-dev");
    expect(evt.creature_id).toBe("c-test");
    expect(evt.summary).toContain("Creature completed");
  });

  test("throws when creature not found or already completed", async () => {
    _sqlRows = []; // DB returns empty — already completed or missing

    await expect(completeCreature("c-gone")).rejects.toThrow(
      "not found or already completed",
    );
  });

  test("accepts optional result payload", async () => {
    const row = makeCreatureRow({ state: "completed", completed_at: new Date() });
    _sqlRows = [row];

    // Should not throw when result is provided
    const creature = await completeCreature("c-test", { output: "done" });
    expect(creature.state).toBe("completed");
  });
});

// ── failCreature ──────────────────────────────────────────────

describe("failCreature — dispatched/working → failed", () => {
  test("returns failed creature", async () => {
    const row = makeCreatureRow({ state: "failed", completed_at: new Date(), error: "boom" });
    _sqlRows = [row];

    const creature = await failCreature("c-test", "boom");

    expect(creature.state).toBe("failed");
    expect(creature.id).toBe("c-test");
  });

  test("emits creature.failed event", async () => {
    const row = makeCreatureRow({ state: "failed", completed_at: new Date(), error: "agent-error" });
    _sqlRows = [row];

    await failCreature("c-test", "agent-error");

    expect(_emittedEvents).toHaveLength(1);
    const evt = _emittedEvents[0];
    expect(evt.kind).toBe("creature.failed");
    expect(evt.tree_id).toBe("tree-1");
    expect(evt.creature_id).toBe("c-test");
    expect(evt.summary).toContain("agent-error");
  });

  test("throws when creature not found or already completed", async () => {
    _sqlRows = []; // DB returns empty — already terminal

    await expect(failCreature("c-done", "late-error")).rejects.toThrow(
      "not found or already completed",
    );
  });
});

// ── dispatchCreature ──────────────────────────────────────────

describe("dispatchCreature — initial dispatch", () => {
  test("returns dispatched creature with correct fields", async () => {
    const row = makeCreatureRow({ state: "dispatched" });
    // dispatchCreature makes 3 SQL calls: INSERT creatures, INSERT tree_entities, emitEvent
    // We return the creature row on first call, then empty for the rest
    let callCount = 0;
    const fn: any = (..._args: any[]) => {
      callCount++;
      if (callCount === 1) return Promise.resolve([row]);
      return Promise.resolve([]);
    };
    fn.json = (v: any) => v;
    fn.begin = async (cb: any) => cb(fn);

    // Re-register the mock with per-call control
    // (The module-level mock returns _sqlRows; we use _sqlRows for this)
    _sqlRows = [row];

    // Note: dispatchCreature calls sql three times. The module-level mock always
    // returns _sqlRows, so we set it to return the creature on all calls.
    const creature = await dispatchCreature({
      type: "pull",
      tree_id: "tree-1",
      entity_id: "entity-dev",
      intent: "test dispatch",
    });

    expect(creature.state).toBe("dispatched");
    expect(creature.type).toBe("pull");
    expect(creature.tree_id).toBe("tree-1");
    expect(creature.entity_id).toBe("entity-dev");
    expect(creature.intent).toBe("test intent"); // from _sqlRows mock
  });

  test("emits creature.dispatched event", async () => {
    const row = makeCreatureRow({ state: "dispatched" });
    _sqlRows = [row];

    await dispatchCreature({
      type: "pull",
      tree_id: "tree-dispatched",
      entity_id: "entity-dev",
      intent: "dispatch test",
    });

    const evt = _emittedEvents.find(e => e.kind === "creature.dispatched");
    expect(evt).toBeDefined();
    expect(evt.tree_id).toBe("tree-dispatched");
    expect(evt.entity_id).toBe("entity-dev");
    expect(evt.summary).toContain("Creature dispatched");
  });
});

// ── State machine contract ────────────────────────────────────

describe("state machine contract", () => {
  test("error messages identify the creature by ID", async () => {
    _sqlRows = [];

    const err1 = await startCreature("creature-abc").catch(e => e.message);
    const err2 = await completeCreature("creature-xyz").catch(e => e.message);
    const err3 = await failCreature("creature-qrs", "any").catch(e => e.message);

    expect(err1).toContain("creature-abc");
    expect(err2).toContain("creature-xyz");
    expect(err3).toContain("creature-qrs");
  });

  test("completeCreature emits event even when result is undefined", async () => {
    const row = makeCreatureRow({ state: "completed", completed_at: new Date() });
    _sqlRows = [row];

    await completeCreature("c-test"); // no result arg

    expect(_emittedEvents).toHaveLength(1);
    expect(_emittedEvents[0].kind).toBe("creature.completed");
  });

  test("failCreature error string is included in event summary", async () => {
    const row = makeCreatureRow({ state: "failed", completed_at: new Date(), error: "timeout-exceeded" });
    _sqlRows = [row];

    await failCreature("c-test", "timeout-exceeded");

    expect(_emittedEvents[0].summary).toContain("timeout-exceeded");
  });
});
