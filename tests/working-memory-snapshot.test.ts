/**
 * ELLIE-923 Phase 1: Pre-compaction working memory snapshot tests
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { initWorkingMemory, snapshotWorkingMemoryToForest, type WorkingMemorySections } from "../src/working-memory.ts";
import { getMemory, sql } from "../../ellie-forest/src/index.ts";

describe("Working Memory Snapshot (ELLIE-923 Phase 1)", () => {
  const testSessionId = `test-snapshot-${Date.now()}`;
  const testAgent = "dev";

  beforeEach(async () => {
    // Clean up any existing test sessions
    await sql`
      UPDATE working_memory
      SET archived_at = NOW()
      WHERE session_id LIKE 'test-snapshot-%'
    `;
  });

  test("creates snapshot with all 7 sections", async () => {
    // Initialize working memory with all sections populated
    const sections: WorkingMemorySections = {
      session_identity: "Agent: dev | Ticket: ELLIE-923 | Channel: telegram",
      task_stack: "1. Implement snapshot function\n2. Write tests\n3. Integration",
      conversation_thread: "User asked to implement pre-compaction snapshot. Discussed requirements.",
      investigation_state: "Files examined: working-memory.ts, session-compaction.ts",
      decision_log: "Decision: Use Forest Bridge API for snapshot storage. Reasoning: Consistent with existing patterns.",
      context_anchors: "Critical: Must preserve all 7 sections. Error: None yet.",
      resumption_prompt: "Continue with test implementation after snapshot verified.",
    };

    await initWorkingMemory({
      session_id: testSessionId,
      agent: testAgent,
      sections,
      channel: "telegram",
    });

    // Create snapshot
    const memoryId = await snapshotWorkingMemoryToForest({
      session_id: testSessionId,
      agent: testAgent,
      work_item_id: "ELLIE-923",
      scope_path: "2/1",
    });

    expect(memoryId).toBeTruthy();
    expect(typeof memoryId).toBe("string");

    // Verify the snapshot was written to Forest
    const memory = await getMemory(memoryId!);
    expect(memory).toBeTruthy();
    expect(memory?.type).toBe("finding");
    expect(memory?.scope_path).toBe("2/1");
    expect(memory?.tags).toContain("working_memory_snapshot");
    expect(memory?.tags).toContain("agent:dev");

    // Verify metadata
    const metadata = memory?.metadata as Record<string, unknown>;
    expect(metadata?.snapshot_source).toBe("pre_compaction");
    expect(metadata?.session_id).toBe(testSessionId);
    expect(metadata?.agent).toBe(testAgent);
    expect(metadata?.work_item_id).toBe("ELLIE-923");
    expect(metadata?.turn_number).toBe(0);

    // Verify content includes all sections
    const content = memory?.content ?? "";
    expect(content).toContain("Pre-compaction snapshot");
    expect(content).toContain("Session Identity");
    expect(content).toContain("Task Stack");
    expect(content).toContain("Conversation Thread");
    expect(content).toContain("Investigation State");
    expect(content).toContain("Decision Log");
    expect(content).toContain("Context Anchors");
    expect(content).toContain("Resumption Prompt");
    expect(content).toContain("ELLIE-923");
  });

  test("handles missing sections gracefully", async () => {
    // Initialize with only partial sections
    const sections: WorkingMemorySections = {
      session_identity: "Agent: dev | Ticket: ELLIE-923",
      decision_log: "Decision: Test partial snapshot",
    };

    await initWorkingMemory({
      session_id: testSessionId + "-partial",
      agent: testAgent,
      sections,
    });

    const memoryId = await snapshotWorkingMemoryToForest({
      session_id: testSessionId + "-partial",
      agent: testAgent,
      scope_path: "2/1",
    });

    expect(memoryId).toBeTruthy();

    const memory = await getMemory(memoryId!);
    const content = memory?.content ?? "";

    // Should include provided sections
    expect(content).toContain("Session Identity");
    expect(content).toContain("Decision Log");

    // Should not include empty sections
    expect(content).not.toContain("Task Stack\n##");
    expect(content).not.toContain("Conversation Thread\n##");
  });

  test("returns null when no active working memory exists", async () => {
    const memoryId = await snapshotWorkingMemoryToForest({
      session_id: "nonexistent-session",
      agent: testAgent,
      scope_path: "2/1",
    });

    expect(memoryId).toBeNull();
  });

  test("uses default scope_path when not provided", async () => {
    await initWorkingMemory({
      session_id: testSessionId + "-default-scope",
      agent: testAgent,
      sections: { session_identity: "Test default scope" },
    });

    const memoryId = await snapshotWorkingMemoryToForest({
      session_id: testSessionId + "-default-scope",
      agent: testAgent,
    });

    expect(memoryId).toBeTruthy();

    const memory = await getMemory(memoryId!);
    expect(memory?.scope_path).toBe("2/1"); // Default for ellie-dev
  });

  test("includes turn_number in snapshot", async () => {
    const record = await initWorkingMemory({
      session_id: testSessionId + "-turn",
      agent: testAgent,
      sections: { session_identity: "Turn test" },
    });

    // Simulate a few turns
    await sql`
      UPDATE working_memory
      SET turn_number = 5
      WHERE id = ${record.id}
    `;

    const memoryId = await snapshotWorkingMemoryToForest({
      session_id: testSessionId + "-turn",
      agent: testAgent,
      scope_path: "2/1",
    });

    expect(memoryId).toBeTruthy();

    const memory = await getMemory(memoryId!);
    const metadata = memory?.metadata as Record<string, unknown>;
    expect(metadata?.turn_number).toBe(5);

    const content = memory?.content ?? "";
    expect(content).toContain("Turn 5");
  });
});
