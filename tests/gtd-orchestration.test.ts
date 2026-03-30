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
