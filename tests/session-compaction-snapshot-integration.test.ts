/**
 * ELLIE-923 Phase 1: Integration test for pre-compaction snapshot
 *
 * Verifies that checkpointSessionToForest triggers working memory snapshot.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { initWorkingMemory, type WorkingMemorySections } from "../src/working-memory.ts";
import { checkpointSessionToForest, type ContextPressure } from "../src/api/session-compaction.ts";
import { sql, getMemory } from "../../ellie-forest/src/index.ts";

describe("Session Compaction Snapshot Integration (ELLIE-923)", () => {
  const testSessionId = `test-compaction-snapshot-${Date.now()}`;
  const testAgent = "dev";

  beforeEach(async () => {
    // Clean up test sessions
    await sql`
      UPDATE working_memory
      SET archived_at = NOW()
      WHERE session_id LIKE 'test-compaction-snapshot-%'
    `;
  });

  test("checkpointSessionToForest creates working memory snapshot", async () => {
    // Setup: Create working memory with full state
    const sections: WorkingMemorySections = {
      session_identity: `Agent: ${testAgent} | Ticket: ELLIE-923 | Channel: telegram`,
      task_stack: "1. Test integration\n2. Verify snapshot",
      conversation_thread: "Testing pre-compaction snapshot integration",
      investigation_state: "Examining checkpointSessionToForest flow",
      decision_log: "Decision: Snapshot should be created before checkpoint",
      context_anchors: "Critical: Session ID = " + testSessionId,
      resumption_prompt: "Verify snapshot was created successfully",
    };

    await initWorkingMemory({
      session_id: testSessionId,
      agent: testAgent,
      sections,
      channel: "telegram",
    });

    // Create mock context pressure
    const pressure: ContextPressure = {
      level: "critical",
      pct: 0.87,
      tokensUsed: 87000,
      budget: 100000,
    };

    // Execute checkpoint (which should trigger snapshot)
    await checkpointSessionToForest({
      conversationId: testSessionId,
      agentName: testAgent,
      mode: "work",
      workItemId: "ELLIE-923",
      pressure,
      sections: [
        { label: "working_memory", tokens: 2000 },
        { label: "messages", tokens: 50000 },
        { label: "forest_context", tokens: 35000 },
      ],
      lastUserMessage: "Test the pre-compaction snapshot integration",
    });

    // Verify: Search Forest for the snapshot
    const snapshots = await sql`
      SELECT id, content, type, tags, metadata, scope_path
      FROM shared_memories
      WHERE tags @> ARRAY['working_memory_snapshot']::text[]
        AND metadata->>'session_id' = ${testSessionId}
        AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `;

    expect(snapshots.length).toBe(1);

    const snapshot = snapshots[0];
    expect(snapshot.type).toBe("finding");
    expect(snapshot.scope_path).toBe("2/1");
    expect(snapshot.tags).toContain("working_memory_snapshot");
    expect(snapshot.tags).toContain(`agent:${testAgent}`);

    const metadata = snapshot.metadata as Record<string, unknown>;
    expect(metadata.snapshot_source).toBe("pre_compaction");
    expect(metadata.session_id).toBe(testSessionId);
    expect(metadata.agent).toBe(testAgent);
    expect(metadata.work_item_id).toBe("ELLIE-923");

    // Verify content includes all sections
    const content = snapshot.content as string;
    expect(content).toContain("Pre-compaction snapshot");
    expect(content).toContain("Session Identity");
    expect(content).toContain("Task Stack");
    expect(content).toContain("Conversation Thread");
    expect(content).toContain("Investigation State");
    expect(content).toContain("Decision Log");
    expect(content).toContain("Context Anchors");
    expect(content).toContain("Resumption Prompt");

    // Verify the regular checkpoint was also created
    const checkpoints = await sql`
      SELECT id, content, type, tags, metadata
      FROM shared_memories
      WHERE tags @> ARRAY['session-checkpoint']::text[]
        AND metadata->>'conversation_id' = ${testSessionId}
        AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `;

    expect(checkpoints.length).toBe(1);
    const checkpoint = checkpoints[0];
    expect(checkpoint.type).toBe("finding");

    const checkpointMeta = checkpoint.metadata as Record<string, unknown>;
    expect(checkpointMeta.conversation_id).toBe(testSessionId);
    expect(checkpointMeta.checkpoint).toBe(true);
    expect(checkpointMeta.pressure_pct).toBe(0.87);
  });

  test("checkpoint completes even if snapshot fails", async () => {
    // Don't create working memory — snapshot should fail gracefully
    const pressure: ContextPressure = {
      level: "critical",
      pct: 0.90,
      tokensUsed: 90000,
      budget: 100000,
    };

    // Should not throw even though no working memory exists
    await expect(
      checkpointSessionToForest({
        conversationId: "nonexistent-session-for-snapshot-test",
        agentName: testAgent,
        mode: "work",
        workItemId: "ELLIE-923",
        pressure,
        sections: [
          { label: "messages", tokens: 50000 },
        ],
        lastUserMessage: "Test graceful failure",
      })
    ).resolves.toBeUndefined();

    // Verify the regular checkpoint was still created
    const checkpoints = await sql`
      SELECT id, content
      FROM shared_memories
      WHERE tags @> ARRAY['session-checkpoint']::text[]
        AND metadata->>'conversation_id' = 'nonexistent-session-for-snapshot-test'
        AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `;

    expect(checkpoints.length).toBe(1);
  });

  test("snapshot includes correct turn_number from working memory", async () => {
    // Create working memory and simulate multiple turns
    const record = await initWorkingMemory({
      session_id: testSessionId + "-turns",
      agent: testAgent,
      sections: {
        session_identity: "Turn tracking test",
        conversation_thread: "Simulating a multi-turn session",
      },
    });

    // Update turn number
    await sql`
      UPDATE working_memory
      SET turn_number = 12
      WHERE id = ${record.id}
    `;

    const pressure: ContextPressure = {
      level: "critical",
      pct: 0.85,
      tokensUsed: 85000,
      budget: 100000,
    };

    await checkpointSessionToForest({
      conversationId: testSessionId + "-turns",
      agentName: testAgent,
      mode: "work",
      workItemId: "ELLIE-923",
      pressure,
      sections: [{ label: "messages", tokens: 85000 }],
      lastUserMessage: "Turn 12 message",
    });

    // Verify snapshot has correct turn number
    const snapshots = await sql`
      SELECT metadata, content
      FROM shared_memories
      WHERE tags @> ARRAY['working_memory_snapshot']::text[]
        AND metadata->>'session_id' = ${testSessionId + "-turns"}
        AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `;

    expect(snapshots.length).toBe(1);
    const metadata = snapshots[0].metadata as Record<string, unknown>;
    expect(metadata.turn_number).toBe(12);

    const content = snapshots[0].content as string;
    expect(content).toContain("Turn 12");
  });
});
