/**
 * ELLIE-640 — Three-tier memory architecture tests
 *
 * Tests the memory tier system: core (always loaded), extended (search),
 * goals (lifecycle with status tracking).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  writeMemory, getMemory,
  getCoreMemories, getActiveGoals,
  promoteToCore, demoteToExtended,
  convertToGoal, updateGoalStatus, completeGoal,
  markOverdueGoals, countByTier,
  archiveMemory,
} from "../../ellie-forest/src/index";
import sql from "../../ellie-forest/src/db";
import type { SharedMemory, MemoryTier, GoalStatus } from "../../ellie-forest/src/types";

// Track created memory IDs for cleanup
const createdIds: string[] = [];

async function cleanup() {
  if (createdIds.length === 0) return;
  await sql`DELETE FROM shared_memories WHERE id = ANY(${createdIds})`;
  createdIds.length = 0;
}

afterAll(cleanup);

// ── Type tests ──────────────────────────────────────────────

describe("MemoryTier type", () => {
  test("valid tier values", () => {
    const tiers: MemoryTier[] = ["core", "extended", "goals"];
    expect(tiers).toHaveLength(3);
    expect(tiers).toContain("core");
    expect(tiers).toContain("extended");
    expect(tiers).toContain("goals");
  });
});

describe("GoalStatus type", () => {
  test("valid goal status values", () => {
    const statuses: GoalStatus[] = ["active", "blocked", "completed", "overdue"];
    expect(statuses).toHaveLength(4);
  });
});

// ── writeMemory with tier ───────────────────────────────────

describe("writeMemory with memory_tier", () => {
  test("defaults to extended tier", async () => {
    const mem = await writeMemory({
      content: `test-640-default-tier-${Date.now()}`,
      type: "fact",
      scope: "global",
      confidence: 0.8,
    });
    createdIds.push(mem.id);
    expect(mem.memory_tier).toBe("extended");
    expect(mem.goal_status).toBeNull();
  });

  test("can write directly to core tier", async () => {
    const mem = await writeMemory({
      content: `test-640-core-direct-${Date.now()}`,
      type: "fact",
      scope: "global",
      memory_tier: "core",
      confidence: 0.9,
    });
    createdIds.push(mem.id);
    expect(mem.memory_tier).toBe("core");
  });

  test("can write a goal with lifecycle fields", async () => {
    const deadline = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const mem = await writeMemory({
      content: `test-640-goal-write-${Date.now()}`,
      type: "fact",
      scope: "global",
      memory_tier: "goals",
      goal_status: "active",
      goal_deadline: deadline,
      goal_progress: 0.25,
      completion_criteria: "All tests passing",
      confidence: 0.8,
    });
    createdIds.push(mem.id);
    expect(mem.memory_tier).toBe("goals");
    expect(mem.goal_status).toBe("active");
    expect(mem.goal_progress).toBe(0.25);
    expect(mem.completion_criteria).toBe("All tests passing");
    expect(mem.goal_deadline).toBeTruthy();
  });

  test("constraint prevents goal fields on non-goals tier", async () => {
    try {
      const mem = await writeMemory({
        content: `test-640-bad-constraint-${Date.now()}`,
        type: "fact",
        scope: "global",
        memory_tier: "extended",
        goal_status: "active",
        confidence: 0.5,
      });
      // If it got here, the constraint didn't fire — clean up and fail
      createdIds.push(mem.id);
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message || err.toString()).toContain("chk_goal_fields_require_goals_tier");
    }
  });
});

// ── getCoreMemories ─────────────────────────────────────────

describe("getCoreMemories", () => {
  let coreId: string;

  beforeAll(async () => {
    const mem = await writeMemory({
      content: `test-640-core-retrieve-${Date.now()}`,
      type: "preference",
      scope: "global",
      memory_tier: "core",
      confidence: 0.95,
      category: "identity",
    });
    coreId = mem.id;
    createdIds.push(coreId);
  });

  test("returns core tier memories", async () => {
    const cores = await getCoreMemories();
    const found = cores.find(m => m.id === coreId);
    expect(found).toBeTruthy();
    expect(found!.memory_tier).toBe("core");
  });

  test("does not return extended memories", async () => {
    const ext = await writeMemory({
      content: `test-640-ext-should-not-appear-${Date.now()}`,
      type: "fact",
      scope: "global",
      memory_tier: "extended",
      confidence: 0.5,
    });
    createdIds.push(ext.id);

    const cores = await getCoreMemories();
    const found = cores.find(m => m.id === ext.id);
    expect(found).toBeUndefined();
  });

  test("respects category filter", async () => {
    const cores = await getCoreMemories({ category: "identity" });
    const found = cores.find(m => m.id === coreId);
    expect(found).toBeTruthy();

    const wrongCat = await getCoreMemories({ category: "fitness" });
    const notFound = wrongCat.find(m => m.id === coreId);
    expect(notFound).toBeUndefined();
  });

  test("respects limit", async () => {
    const cores = await getCoreMemories({ limit: 1 });
    expect(cores.length).toBeLessThanOrEqual(1);
  });
});

// ── getActiveGoals ──────────────────────────────────────────

describe("getActiveGoals", () => {
  let activeGoalId: string;
  let blockedGoalId: string;
  let completedGoalId: string;

  beforeAll(async () => {
    const active = await writeMemory({
      content: `test-640-goal-active-${Date.now()}`,
      type: "fact",
      scope: "global",
      memory_tier: "goals",
      goal_status: "active",
      goal_progress: 0.5,
      confidence: 0.8,
    });
    activeGoalId = active.id;
    createdIds.push(activeGoalId);

    const blocked = await writeMemory({
      content: `test-640-goal-blocked-${Date.now()}`,
      type: "fact",
      scope: "global",
      memory_tier: "goals",
      goal_status: "blocked",
      goal_progress: 0.3,
      confidence: 0.7,
    });
    blockedGoalId = blocked.id;
    createdIds.push(blockedGoalId);

    const completed = await writeMemory({
      content: `test-640-goal-completed-${Date.now()}`,
      type: "fact",
      scope: "global",
      memory_tier: "goals",
      goal_status: "completed",
      goal_progress: 1.0,
      confidence: 0.9,
    });
    completedGoalId = completed.id;
    createdIds.push(completedGoalId);
  });

  test("returns active goals", async () => {
    const goals = await getActiveGoals();
    const found = goals.find(g => g.id === activeGoalId);
    expect(found).toBeTruthy();
  });

  test("returns blocked goals by default", async () => {
    const goals = await getActiveGoals();
    const found = goals.find(g => g.id === blockedGoalId);
    expect(found).toBeTruthy();
  });

  test("can exclude blocked goals", async () => {
    const goals = await getActiveGoals({ include_blocked: false });
    const found = goals.find(g => g.id === blockedGoalId);
    expect(found).toBeUndefined();
  });

  test("does not return completed goals", async () => {
    const goals = await getActiveGoals();
    const found = goals.find(g => g.id === completedGoalId);
    expect(found).toBeUndefined();
  });
});

// ── Tier transitions ────────────────────────────────────────

describe("promoteToCore", () => {
  test("promotes extended memory to core", async () => {
    const mem = await writeMemory({
      content: `test-640-promote-${Date.now()}`,
      type: "preference",
      scope: "global",
      confidence: 0.9,
    });
    createdIds.push(mem.id);
    expect(mem.memory_tier).toBe("extended");

    const promoted = await promoteToCore(mem.id);
    expect(promoted.memory_tier).toBe("core");
    expect(promoted.id).toBe(mem.id);
  });

  test("clears goal fields when promoting goal to core", async () => {
    const goal = await writeMemory({
      content: `test-640-promote-goal-${Date.now()}`,
      type: "fact",
      scope: "global",
      memory_tier: "goals",
      goal_status: "active",
      goal_progress: 0.5,
      completion_criteria: "test criteria",
      confidence: 0.8,
    });
    createdIds.push(goal.id);

    const promoted = await promoteToCore(goal.id);
    expect(promoted.memory_tier).toBe("core");
    expect(promoted.goal_status).toBeNull();
    expect(promoted.goal_progress).toBeNull();
    expect(promoted.completion_criteria).toBeNull();
  });

  test("throws for non-existent memory", async () => {
    await expect(promoteToCore("00000000-0000-0000-0000-000000000000")).rejects.toThrow();
  });
});

describe("demoteToExtended", () => {
  test("demotes core memory to extended", async () => {
    const mem = await writeMemory({
      content: `test-640-demote-${Date.now()}`,
      type: "fact",
      scope: "global",
      memory_tier: "core",
      confidence: 0.9,
    });
    createdIds.push(mem.id);

    const demoted = await demoteToExtended(mem.id);
    expect(demoted.memory_tier).toBe("extended");
  });
});

describe("convertToGoal", () => {
  test("converts extended memory to goal with lifecycle", async () => {
    const mem = await writeMemory({
      content: `test-640-convert-goal-${Date.now()}`,
      type: "fact",
      scope: "global",
      confidence: 0.7,
    });
    createdIds.push(mem.id);

    const deadline = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const goal = await convertToGoal(mem.id, {
      goal_status: "active",
      goal_deadline: deadline,
      goal_progress: 0,
      completion_criteria: "Ship the feature",
    });
    expect(goal.memory_tier).toBe("goals");
    expect(goal.goal_status).toBe("active");
    expect(goal.goal_progress).toBe(0);
    expect(goal.completion_criteria).toBe("Ship the feature");
  });
});

// ── Goal lifecycle ──────────────────────────────────────────

describe("updateGoalStatus", () => {
  test("updates goal progress", async () => {
    const goal = await writeMemory({
      content: `test-640-update-progress-${Date.now()}`,
      type: "fact",
      scope: "global",
      memory_tier: "goals",
      goal_status: "active",
      goal_progress: 0.2,
      confidence: 0.7,
    });
    createdIds.push(goal.id);

    const updated = await updateGoalStatus(goal.id, { goal_progress: 0.8 });
    expect(updated.goal_progress).toBe(0.8);
    expect(updated.goal_status).toBe("active");
  });

  test("changes goal status to blocked", async () => {
    const goal = await writeMemory({
      content: `test-640-block-goal-${Date.now()}`,
      type: "fact",
      scope: "global",
      memory_tier: "goals",
      goal_status: "active",
      goal_progress: 0.5,
      confidence: 0.7,
    });
    createdIds.push(goal.id);

    const updated = await updateGoalStatus(goal.id, { goal_status: "blocked" });
    expect(updated.goal_status).toBe("blocked");
  });

  test("throws for non-goal memory", async () => {
    const mem = await writeMemory({
      content: `test-640-not-a-goal-${Date.now()}`,
      type: "fact",
      scope: "global",
      confidence: 0.5,
    });
    createdIds.push(mem.id);

    await expect(updateGoalStatus(mem.id, { goal_status: "blocked" })).rejects.toThrow();
  });
});

describe("completeGoal", () => {
  test("completes a goal with progress set to 1.0", async () => {
    const goal = await writeMemory({
      content: `test-640-complete-goal-${Date.now()}`,
      type: "fact",
      scope: "global",
      memory_tier: "goals",
      goal_status: "active",
      goal_progress: 0.7,
      confidence: 0.8,
    });
    createdIds.push(goal.id);

    const completed = await completeGoal(goal.id);
    expect(completed.goal_status).toBe("completed");
    expect(completed.goal_progress).toBe(1.0);
    expect(completed.memory_tier).toBe("goals"); // stays in goals by default
  });

  test("can demote to extended on completion", async () => {
    const goal = await writeMemory({
      content: `test-640-complete-demote-${Date.now()}`,
      type: "fact",
      scope: "global",
      memory_tier: "goals",
      goal_status: "active",
      goal_progress: 0.9,
      confidence: 0.8,
    });
    createdIds.push(goal.id);

    const completed = await completeGoal(goal.id, { demote_to_extended: true });
    expect(completed.memory_tier).toBe("extended");
    // Goal fields cleared to satisfy constraint — completion tracked in metadata
    expect(completed.goal_status).toBeNull();
    expect((completed.metadata as any).completed_goal).toBe(true);
  });
});

describe("markOverdueGoals", () => {
  test("marks goals past deadline as overdue", async () => {
    const pastDeadline = new Date(Date.now() - 24 * 60 * 60 * 1000); // yesterday
    const goal = await writeMemory({
      content: `test-640-overdue-${Date.now()}`,
      type: "fact",
      scope: "global",
      memory_tier: "goals",
      goal_status: "active",
      goal_deadline: pastDeadline,
      confidence: 0.7,
    });
    createdIds.push(goal.id);

    const count = await markOverdueGoals();
    expect(count).toBeGreaterThanOrEqual(1);

    const refreshed = await getMemory(goal.id);
    expect(refreshed!.goal_status).toBe("overdue");
  });

  test("does not mark future-deadline goals as overdue", async () => {
    const futureDeadline = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const goal = await writeMemory({
      content: `test-640-not-overdue-${Date.now()}`,
      type: "fact",
      scope: "global",
      memory_tier: "goals",
      goal_status: "active",
      goal_deadline: futureDeadline,
      confidence: 0.7,
    });
    createdIds.push(goal.id);

    await markOverdueGoals();

    const refreshed = await getMemory(goal.id);
    expect(refreshed!.goal_status).toBe("active");
  });
});

// ── countByTier ─────────────────────────────────────────────

describe("countByTier", () => {
  test("returns counts for all three tiers", async () => {
    const counts = await countByTier();
    expect(counts).toHaveProperty("core");
    expect(counts).toHaveProperty("extended");
    expect(counts).toHaveProperty("goals");
    expect(typeof counts.core).toBe("number");
    expect(typeof counts.extended).toBe("number");
    expect(typeof counts.goals).toBe("number");
  });

  test("extended count is non-zero (backfilled existing memories)", async () => {
    const counts = await countByTier();
    expect(counts.extended).toBeGreaterThan(0);
  });
});

// ── Backward compatibility ──────────────────────────────────

describe("backward compatibility", () => {
  test("existing readMemories still works (includes all tiers)", async () => {
    const { readMemories } = await import("../../ellie-forest/src/index");
    // readMemories without tier filter should still return memories
    // We just verify it doesn't throw — actual results depend on embeddings
    const results = await readMemories({
      query: "test backward compat",
      scope: "global",
      match_count: 5,
    });
    expect(Array.isArray(results)).toBe(true);
  });

  test("getMemory returns memory_tier field", async () => {
    const mem = await writeMemory({
      content: `test-640-compat-getmem-${Date.now()}`,
      type: "fact",
      scope: "global",
      confidence: 0.5,
    });
    createdIds.push(mem.id);

    const fetched = await getMemory(mem.id);
    expect(fetched).toBeTruthy();
    expect(fetched!.memory_tier).toBe("extended");
  });
});
