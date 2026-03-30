/**
 * GTD Orchestration CRUD — Integration Tests (ELLIE-1151)
 *
 * Tests the orchestration CRUD library against the actual Supabase database.
 * Each test creates items and hard-deletes them in afterAll cleanup.
 */

import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ── Mock logger before any src imports ────────────────────────

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));

// ── Mock relay-state to provide a real Supabase client ────────

let _testSupabase: SupabaseClient | null = null;

mock.module("../src/relay-state.ts", () => ({
  getRelayDeps: () => {
    if (!_testSupabase) throw new Error("Test Supabase not initialized");
    return { supabase: _testSupabase, bot: null, anthropic: null };
  },
  broadcastDispatchEvent: () => {},  // no-op — relay-state not initialized in tests
}));

// ── Now import the module under test ──────────────────────────

import {
  createOrchestrationParent,
  createDispatchChild,
  createQuestionItem,
  getActiveOrchestrationTrees,
  updateItemStatus,
  cancelItem,
  answerQuestion,
  getOrchestrationBadgeCount,
  findOrphanedParents,
  timeoutStaleChildren,
} from "../src/gtd-orchestration.ts";

// ── Setup ─────────────────────────────────────────────────────

const createdIds: string[] = [];
let supabaseAvailable = false;

beforeAll(() => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (url && key) {
    _testSupabase = createClient(url, key);
    supabaseAvailable = true;
  } else {
    console.warn(
      "[SKIP] SUPABASE_URL/SUPABASE_ANON_KEY not set — all GTD orchestration integration tests will be skipped. " +
      "Set these env vars to run against a real Supabase instance.",
    );
  }
});

afterAll(async () => {
  // Hard-delete all created test items (children first to avoid FK constraint issues)
  if (_testSupabase && createdIds.length > 0) {
    // Reverse order: children/grandchildren were tracked after parents
    const idsToDelete = [...createdIds].reverse();
    for (const id of idsToDelete) {
      try {
        await _testSupabase
          .from("todos")
          .delete()
          .eq("id", id);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
});

function track(id: string): string {
  createdIds.push(id);
  return id;
}

// ── Tests ─────────────────────────────────────────────────────

describe("createOrchestrationParent", () => {
  it("creates a parent item with correct fields", async () => {
    if (!supabaseAvailable) { console.log("  [SKIP] Supabase unavailable"); return; }

    const parent = await createOrchestrationParent({
      content: "Test orchestration parent",
      createdBy: "test-agent",
      sourceRef: "ELLIE-TEST-1151",
    });

    track(parent.id);

    expect(parent.id).toBeDefined();
    expect(parent.content).toBe("Test orchestration parent");
    expect(parent.status).toBe("open");
    expect(parent.assigned_to).toBe("ellie");
    expect(parent.is_orchestration).toBe(true);
    expect(parent.created_by).toBe("test-agent");
    expect(parent.source_ref).toBe("ELLIE-TEST-1151");
    expect(parent.parent_id).toBeNull();
  });
});

describe("createDispatchChild", () => {
  it("creates a child item linked to parent", async () => {
    if (!supabaseAvailable) { console.log("  [SKIP] Supabase unavailable"); return; }

    const parent = await createOrchestrationParent({
      content: "Parent for child test",
      createdBy: "test-agent",
    });
    track(parent.id);

    const child = await createDispatchChild({
      parentId: parent.id,
      content: "Dispatch child task",
      assignedAgent: "dev",
      assignedTo: "dev",
      createdBy: "test-agent",
      dispatchEnvelopeId: "env-123",
    });
    track(child.id);

    expect(child.id).toBeDefined();
    expect(child.parent_id).toBe(parent.id);
    expect(child.content).toBe("Dispatch child task");
    expect(child.assigned_agent).toBe("dev");
    expect(child.assigned_to).toBe("dev");
    expect(child.is_orchestration).toBe(true);
    expect(child.status).toBe("open");
    expect(child.created_by).toBe("test-agent");
    expect(child.dispatch_envelope_id).toBe("env-123");
  });
});

describe("createQuestionItem", () => {
  it("creates a blocking grandchild question", async () => {
    if (!supabaseAvailable) { console.log("  [SKIP] Supabase unavailable"); return; }

    const parent = await createOrchestrationParent({
      content: "Parent for question test",
      createdBy: "test-agent",
    });
    track(parent.id);

    const child = await createDispatchChild({
      parentId: parent.id,
      content: "Child for question",
      assignedAgent: "dev",
      assignedTo: "dev",
      createdBy: "test-agent",
    });
    track(child.id);

    const question = await createQuestionItem({
      parentId: child.id,
      content: "Should I use approach A or B?",
      createdBy: "dev-agent",
    });
    track(question.id);

    expect(question.id).toBeDefined();
    expect(question.parent_id).toBe(child.id);
    expect(question.assigned_to).toBe("dave");
    expect(question.is_orchestration).toBe(true);
    expect(question.status).toBe("open");
    expect(question.urgency).toBe("blocking");
    expect(question.created_by).toBe("dev-agent");
  });

  it("accepts custom urgency", async () => {
    if (!supabaseAvailable) { console.log("  [SKIP] Supabase unavailable"); return; }

    const parent = await createOrchestrationParent({
      content: "Parent for low urgency question",
      createdBy: "test-agent",
    });
    track(parent.id);

    const question = await createQuestionItem({
      parentId: parent.id,
      content: "Non-blocking question",
      createdBy: "test-agent",
      urgency: "low",
    });
    track(question.id);

    expect(question.urgency).toBe("low");
  });
});

describe("getActiveOrchestrationTrees", () => {
  it("returns correct tree structure", async () => {
    if (!supabaseAvailable) { console.log("  [SKIP] Supabase unavailable"); return; }

    const parent = await createOrchestrationParent({
      content: "Tree test parent",
      createdBy: "test-agent",
    });
    track(parent.id);

    const child1 = await createDispatchChild({
      parentId: parent.id,
      content: "Tree child 1",
      assignedAgent: "dev",
      assignedTo: "dev",
      createdBy: "test-agent",
    });
    track(child1.id);

    const child2 = await createDispatchChild({
      parentId: parent.id,
      content: "Tree child 2",
      assignedAgent: "research",
      assignedTo: "research",
      createdBy: "test-agent",
    });
    track(child2.id);

    const question = await createQuestionItem({
      parentId: child1.id,
      content: "Question under child 1",
      createdBy: "dev-agent",
    });
    track(question.id);

    const trees = await getActiveOrchestrationTrees();

    // Find our test tree
    const tree = trees.find((t) => t.id === parent.id);
    expect(tree).toBeDefined();
    expect(tree!.content).toBe("Tree test parent");
    expect(tree!.children.length).toBe(2);
    expect(tree!.elapsed_ms).toBeGreaterThan(0);

    // Check nested question
    const devChild = tree!.children.find((c) => c.assigned_agent === "dev");
    expect(devChild).toBeDefined();
    expect(devChild!.children.length).toBe(1);
    expect(devChild!.children[0].content).toBe("Question under child 1");
    expect(devChild!.children[0].assigned_to).toBe("dave");
  });
});

describe("cancelItem", () => {
  it("cascades cancel to children", async () => {
    if (!supabaseAvailable) { console.log("  [SKIP] Supabase unavailable"); return; }

    const parent = await createOrchestrationParent({
      content: "Cancel test parent",
      createdBy: "test-agent",
    });
    track(parent.id);

    const child1 = await createDispatchChild({
      parentId: parent.id,
      content: "Cancel child 1",
      assignedAgent: "dev",
      assignedTo: "dev",
      createdBy: "test-agent",
    });
    track(child1.id);

    const child2 = await createDispatchChild({
      parentId: parent.id,
      content: "Cancel child 2",
      assignedAgent: "research",
      assignedTo: "research",
      createdBy: "test-agent",
    });
    track(child2.id);

    // Cancel the parent
    await cancelItem(parent.id);

    // Verify parent and children are cancelled
    const { data: items } = await _testSupabase!
      .from("todos")
      .select("id, status")
      .in("id", [parent.id, child1.id, child2.id]);

    expect(items).toBeDefined();
    for (const item of items!) {
      expect(item.status).toBe("cancelled");
    }
  });
});

describe("updateItemStatus", () => {
  it("triggers parent auto-completion when all children done", async () => {
    if (!supabaseAvailable) { console.log("  [SKIP] Supabase unavailable"); return; }

    const parent = await createOrchestrationParent({
      content: "Auto-complete test parent",
      createdBy: "test-agent",
    });
    track(parent.id);

    const child1 = await createDispatchChild({
      parentId: parent.id,
      content: "Auto child 1",
      assignedAgent: "dev",
      assignedTo: "dev",
      createdBy: "test-agent",
    });
    track(child1.id);

    const child2 = await createDispatchChild({
      parentId: parent.id,
      content: "Auto child 2",
      assignedAgent: "research",
      assignedTo: "research",
      createdBy: "test-agent",
    });
    track(child2.id);

    // Complete both children
    await updateItemStatus(child1.id, "done");
    await updateItemStatus(child2.id, "done");

    // Verify parent auto-completed to done
    const { data: parentRow } = await _testSupabase!
      .from("todos")
      .select("status, completed_at")
      .eq("id", parent.id)
      .single();

    expect(parentRow!.status).toBe("done");
    expect(parentRow!.completed_at).toBeDefined();
  });

  it("sets parent to waiting_for when a child fails", async () => {
    if (!supabaseAvailable) { console.log("  [SKIP] Supabase unavailable"); return; }

    const parent = await createOrchestrationParent({
      content: "Failure test parent",
      createdBy: "test-agent",
    });
    track(parent.id);

    const child1 = await createDispatchChild({
      parentId: parent.id,
      content: "Fail child 1",
      assignedAgent: "dev",
      assignedTo: "dev",
      createdBy: "test-agent",
    });
    track(child1.id);

    const child2 = await createDispatchChild({
      parentId: parent.id,
      content: "Fail child 2",
      assignedAgent: "research",
      assignedTo: "research",
      createdBy: "test-agent",
    });
    track(child2.id);

    // One done, one failed
    await updateItemStatus(child1.id, "done");
    await updateItemStatus(child2.id, "failed");

    // Verify parent set to waiting_for
    const { data: parentRow } = await _testSupabase!
      .from("todos")
      .select("status")
      .eq("id", parent.id)
      .single();

    expect(parentRow!.status).toBe("waiting_for");
  });
});

describe("answerQuestion", () => {
  it("stores answer in metadata and returns parent_id", async () => {
    if (!supabaseAvailable) { console.log("  [SKIP] Supabase unavailable"); return; }

    const parent = await createOrchestrationParent({
      content: "Answer test parent",
      createdBy: "test-agent",
    });
    track(parent.id);

    const question = await createQuestionItem({
      parentId: parent.id,
      content: "What color should the button be?",
      createdBy: "dev-agent",
    });
    track(question.id);

    const returnedParentId = await answerQuestion(question.id, "Make it blue");

    expect(returnedParentId).toBe(parent.id);

    // Verify the question is done with answer in metadata
    const { data: q } = await _testSupabase!
      .from("todos")
      .select("status, metadata, completed_at")
      .eq("id", question.id)
      .single();

    expect(q!.status).toBe("done");
    expect(q!.completed_at).toBeDefined();
    expect((q!.metadata as Record<string, unknown>).answer).toBe("Make it blue");
  });
});

describe("getOrchestrationBadgeCount", () => {
  it("counts open questions assigned to dave", async () => {
    if (!supabaseAvailable) { console.log("  [SKIP] Supabase unavailable"); return; }

    const parent = await createOrchestrationParent({
      content: "Badge count test parent",
      createdBy: "test-agent",
    });
    track(parent.id);

    // Get baseline count
    const before = await getOrchestrationBadgeCount();

    const q1 = await createQuestionItem({
      parentId: parent.id,
      content: "Badge question 1",
      createdBy: "test-agent",
    });
    track(q1.id);

    const q2 = await createQuestionItem({
      parentId: parent.id,
      content: "Badge question 2",
      createdBy: "test-agent",
    });
    track(q2.id);

    const after = await getOrchestrationBadgeCount();
    expect(after).toBe(before + 2);

    // Answer one, count should decrease
    await answerQuestion(q1.id, "answered");
    const afterAnswer = await getOrchestrationBadgeCount();
    expect(afterAnswer).toBe(before + 1);
  });
});

describe("findOrphanedParents", () => {
  it("finds old open parents past the age threshold", async () => {
    if (!supabaseAvailable) { console.log("  [SKIP] Supabase unavailable"); return; }

    const parent = await createOrchestrationParent({
      content: "Orphan test parent",
      createdBy: "test-agent",
    });
    track(parent.id);

    // With maxAgeMs=0 (everything is "old"), should find the parent we just created
    const orphans = await findOrphanedParents(0);
    const found = orphans.find((o) => o.id === parent.id);
    expect(found).toBeDefined();
    expect(found!.status).toBe("open");
    expect(found!.parent_id).toBeNull();

    // With a very large maxAgeMs, should NOT find it (it's too new)
    const noOrphans = await findOrphanedParents(999_999_999);
    const notFound = noOrphans.find((o) => o.id === parent.id);
    expect(notFound).toBeUndefined();
  });
});

describe("timeoutStaleChildren", () => {
  it("times out old open children of a parent", async () => {
    if (!supabaseAvailable) { console.log("  [SKIP] Supabase unavailable"); return; }

    const parent = await createOrchestrationParent({
      content: "Timeout test parent",
      createdBy: "test-agent",
    });
    track(parent.id);

    const child = await createDispatchChild({
      parentId: parent.id,
      content: "Stale child",
      assignedAgent: "dev",
      assignedTo: "dev",
      createdBy: "test-agent",
    });
    track(child.id);

    // With maxAgeMs=0 (everything is "stale"), should timeout the child
    const count = await timeoutStaleChildren(parent.id, 0);
    expect(count).toBe(1);

    // Verify child status changed
    const { data: childRow } = await _testSupabase!
      .from("todos")
      .select("status")
      .eq("id", child.id)
      .single();

    expect(childRow!.status).toBe("timed_out");

    // Parent should auto-complete to waiting_for (since child timed out)
    const { data: parentRow } = await _testSupabase!
      .from("todos")
      .select("status")
      .eq("id", parent.id)
      .single();

    expect(parentRow!.status).toBe("waiting_for");
  });
});

describe("updateItemStatus — invalid status rejection", () => {
  it("throws on invalid status", async () => {
    if (!supabaseAvailable) { console.log("  [SKIP] Supabase unavailable"); return; }

    const parent = await createOrchestrationParent({
      content: "Invalid status test parent",
      createdBy: "test-agent",
    });
    track(parent.id);

    await expect(updateItemStatus(parent.id, "bogus")).rejects.toThrow(
      'Invalid status "bogus"',
    );
  });
});

// ── ELLIE-1154: Concurrency & transaction boundary tests ─────

describe("concurrent child completions (ELLIE-1154 race condition)", () => {
  it("does not produce duplicate parent updates when children complete simultaneously", async () => {
    if (!supabaseAvailable) { console.log("  [SKIP] Supabase unavailable"); return; }

    const parent = await createOrchestrationParent({
      content: "Concurrent completion test parent",
      createdBy: "test-agent",
    });
    track(parent.id);

    const children = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        createDispatchChild({
          parentId: parent.id,
          content: `Concurrent child ${i}`,
          assignedAgent: "dev",
          assignedTo: "dev",
          createdBy: "test-agent",
        }),
      ),
    );
    for (const c of children) track(c.id);

    // Complete all children concurrently — this is the race condition scenario.
    // Before ELLIE-1154 fix, concurrent checkParentCompletion() calls could
    // both read all-terminal and both try to update the parent.
    await Promise.all(children.map((c) => updateItemStatus(c.id, "done")));

    // Verify parent ended up in exactly one correct terminal state
    const { data: parentRow } = await _testSupabase!
      .from("todos")
      .select("status, completed_at")
      .eq("id", parent.id)
      .single();

    expect(parentRow!.status).toBe("done");
    expect(parentRow!.completed_at).toBeDefined();
  });

  it("handles mixed concurrent completions (some done, some failed)", async () => {
    if (!supabaseAvailable) { console.log("  [SKIP] Supabase unavailable"); return; }

    const parent = await createOrchestrationParent({
      content: "Mixed concurrent test parent",
      createdBy: "test-agent",
    });
    track(parent.id);

    const child1 = await createDispatchChild({
      parentId: parent.id,
      content: "Mixed child 1",
      assignedAgent: "dev",
      assignedTo: "dev",
      createdBy: "test-agent",
    });
    track(child1.id);

    const child2 = await createDispatchChild({
      parentId: parent.id,
      content: "Mixed child 2",
      assignedAgent: "research",
      assignedTo: "research",
      createdBy: "test-agent",
    });
    track(child2.id);

    // Complete both concurrently with different terminal states
    await Promise.all([
      updateItemStatus(child1.id, "done"),
      updateItemStatus(child2.id, "failed"),
    ]);

    const { data: parentRow } = await _testSupabase!
      .from("todos")
      .select("status")
      .eq("id", parent.id)
      .single();

    // Should be waiting_for since one child failed
    expect(parentRow!.status).toBe("waiting_for");
  });
});

describe("cancel cascade atomicity (ELLIE-1154 transaction boundaries)", () => {
  it("atomically cancels deeply nested tree", async () => {
    if (!supabaseAvailable) { console.log("  [SKIP] Supabase unavailable"); return; }

    const parent = await createOrchestrationParent({
      content: "Deep cancel test parent",
      createdBy: "test-agent",
    });
    track(parent.id);

    const child = await createDispatchChild({
      parentId: parent.id,
      content: "Deep cancel child",
      assignedAgent: "dev",
      assignedTo: "dev",
      createdBy: "test-agent",
    });
    track(child.id);

    const grandchild = await createQuestionItem({
      parentId: child.id,
      content: "Deep cancel grandchild question",
      createdBy: "dev-agent",
    });
    track(grandchild.id);

    // Cancel the child — should cascade to grandchild atomically
    await cancelItem(child.id);

    // Verify all descendants are cancelled
    const { data: items } = await _testSupabase!
      .from("todos")
      .select("id, status")
      .in("id", [child.id, grandchild.id]);

    for (const item of items!) {
      expect(item.status).toBe("cancelled");
    }
  });

  it("skips already-terminal items during cascade", async () => {
    if (!supabaseAvailable) { console.log("  [SKIP] Supabase unavailable"); return; }

    const parent = await createOrchestrationParent({
      content: "Terminal skip test parent",
      createdBy: "test-agent",
    });
    track(parent.id);

    const child1 = await createDispatchChild({
      parentId: parent.id,
      content: "Already done child",
      assignedAgent: "dev",
      assignedTo: "dev",
      createdBy: "test-agent",
    });
    track(child1.id);

    const child2 = await createDispatchChild({
      parentId: parent.id,
      content: "Still open child",
      assignedAgent: "research",
      assignedTo: "research",
      createdBy: "test-agent",
    });
    track(child2.id);

    // Complete child1 first
    await updateItemStatus(child1.id, "done");

    // Cancel the parent — child1 should stay "done", child2 should become "cancelled"
    await cancelItem(parent.id);

    const { data: items } = await _testSupabase!
      .from("todos")
      .select("id, status")
      .in("id", [child1.id, child2.id])
      .order("created_at");

    const c1 = items!.find((i) => i.id === child1.id);
    const c2 = items!.find((i) => i.id === child2.id);
    expect(c1!.status).toBe("done"); // preserved
    expect(c2!.status).toBe("cancelled"); // cascaded
  });
});
