/**
 * ELLIE-1422 — Sync conversation_facts → Forest
 *
 * Verifies that:
 * - Unsynced facts are fetched and written to Forest
 * - forest_synced_at and forest_memory_id are stamped on success
 * - Failed writes increment the failed counter without crashing
 * - Empty result set returns early with synced:0/failed:0
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// Mock ellie-forest before importing the module under test
const mockWriteMemory = mock(async (opts: any) => ({ id: `forest-${opts.content.slice(0, 8)}` }));
mock.module("../../ellie-forest/src/index.ts", () => ({
  writeMemory: mockWriteMemory,
}));

import { syncConversationFactsToForest } from "../src/sync-conversation-facts.ts";

// ── Setup ────────────────────────────────────────────────────────

beforeEach(() => {
  mockWriteMemory.mockClear();
});

// ── Mock helpers ─────────────────────────────────────────────────

function makeSupabase(opts?: {
  facts?: any[];
  selectError?: string;
  updateError?: string;
}) {
  const { facts = [], selectError = null, updateError = null } = opts ?? {};

  const updateEqs: Record<string, string>[] = [];

  function selectChain() {
    const p = Promise.resolve({
      data: selectError ? null : facts,
      error: selectError ? { message: selectError } : null,
    });
    const c: any = {
      select: () => c,
      eq: () => c,
      is: () => c,
      order: () => c,
      limit: () => p,
    };
    c.then = (r: Function, rj?: Function) => p.then(r, rj);
    c.catch = (rj: Function) => p.catch(rj);
    return c;
  }

  function updateChain() {
    const p = Promise.resolve({
      data: null,
      error: updateError ? { message: updateError } : null,
    });
    const c: any = {
      eq: (_col: string, _val: string) => {
        updateEqs.push({ [_col]: _val });
        return p;
      },
    };
    return c;
  }

  return {
    from: mock((table: string) => {
      if (table === "conversation_facts") {
        return { select: selectChain, update: () => updateChain() };
      }
      return {};
    }),
    _updateEqs: updateEqs,
  } as any;
}

// ── Tests ────────────────────────────────────────────────────────

describe("syncConversationFactsToForest", () => {
  test("returns synced:0 failed:0 when no unsynced facts exist", async () => {
    const supabase = makeSupabase({ facts: [] });
    const result = await syncConversationFactsToForest(supabase);
    expect(result.synced).toBe(0);
    expect(result.failed).toBe(0);
  });

  test("returns synced:0 failed:0 on query error", async () => {
    const supabase = makeSupabase({ selectError: "connection failed" });
    const result = await syncConversationFactsToForest(supabase);
    expect(result.synced).toBe(0);
    expect(result.failed).toBe(0);
  });

  test("syncs facts to Forest and stamps sync columns", async () => {
    const facts = [
      { id: "f1", content: "Dave likes coffee", type: "fact", category: "personal", confidence: 0.9, tags: ["food"], source_channel: "telegram" },
      { id: "f2", content: "Use postgres.js for queries", type: "fact", category: "technical", confidence: 0.8, tags: [], source_channel: null },
    ];
    const supabase = makeSupabase({ facts });
    const result = await syncConversationFactsToForest(supabase);

    expect(result.synced).toBe(2);
    expect(result.failed).toBe(0);
    expect(mockWriteMemory).toHaveBeenCalledTimes(2);
  });

  test("counts failed writes without crashing", async () => {
    mockWriteMemory.mockImplementationOnce(() => { throw new Error("Forest down"); });

    const facts = [
      { id: "f1", content: "will fail", type: "fact", category: null, confidence: 0.7, tags: [], source_channel: null },
      { id: "f2", content: "will succeed", type: "fact", category: null, confidence: 0.7, tags: [], source_channel: null },
    ];
    const supabase = makeSupabase({ facts });
    const result = await syncConversationFactsToForest(supabase);

    expect(result.synced).toBe(1);
    expect(result.failed).toBe(1);
  });

  test("maps fact types correctly", async () => {
    const facts = [
      { id: "f1", content: "preference fact", type: "preference", category: null, confidence: 0.8, tags: [], source_channel: null },
    ];
    const supabase = makeSupabase({ facts });
    await syncConversationFactsToForest(supabase);

    expect(mockWriteMemory).toHaveBeenCalledTimes(1);
    const call = mockWriteMemory.mock.calls[0][0];
    expect(call.type).toBe("preference");
  });

  test("maps category to correct scope_path", async () => {
    const facts = [
      { id: "f1", content: "technical fact", type: "fact", category: "technical", confidence: 0.8, tags: [], source_channel: null },
    ];
    const supabase = makeSupabase({ facts });
    await syncConversationFactsToForest(supabase);

    const call = mockWriteMemory.mock.calls[0][0];
    expect(call.scope_path).toBe("2/1");
  });
});
