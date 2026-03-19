/**
 * ELLIE-922 Phases 2 & 3: Compaction Safeguard Tests
 *
 * Tests verification logic and rollback mechanism for working memory
 * compaction safeguards.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  extractCriticalIdentifiers,
  verifyWorkingMemorySurvived,
  rollbackWorkingMemoryFromSnapshot,
} from "../src/compaction-safeguard.ts";
import {
  initWorkingMemory,
  snapshotWorkingMemoryToForest,
  updateWorkingMemory,
  type WorkingMemorySections,
} from "../src/working-memory.ts";
import { sql } from "../../ellie-forest/src/index.ts";

describe("Compaction Safeguard — ELLIE-922", () => {
  const testSessionId = `test-safeguard-${Date.now()}`;
  const testAgent = "dev";

  beforeEach(async () => {
    // Clean up test sessions and Forest snapshots
    await sql`
      UPDATE working_memory
      SET archived_at = NOW()
      WHERE session_id LIKE 'test-safeguard-%'
    `;

    await sql`
      UPDATE shared_memories
      SET status = 'archived'
      WHERE metadata->>'session_id' LIKE 'test-safeguard-%'
    `;
  });

  // ── Phase 2: Verification Logic ────────────────────────────────────────────

  describe("extractCriticalIdentifiers", () => {
    test("extracts ticket IDs", () => {
      const text = "Working on ELLIE-922 and JIRA-456 today";
      const ids = extractCriticalIdentifiers(text);
      expect(ids).toContain("ELLIE-922");
      expect(ids).toContain("JIRA-456");
    });

    test("extracts hex IDs (8+ chars)", () => {
      const text = "Transaction ID: A1B2C3D4E5F6G7H8";
      const ids = extractCriticalIdentifiers(text);
      expect(ids).toContain("A1B2C3D4E5F6");
    });

    test("extracts URLs", () => {
      const text = "See https://example.com/api/docs and http://localhost:3000";
      const ids = extractCriticalIdentifiers(text);
      expect(ids).toContain("https://example.com/api/docs");
      expect(ids).toContain("http://localhost:3000");
    });

    test("extracts Unix file paths", () => {
      const text = "Modified /home/ellie/ellie-dev/src/working-memory.ts";
      const ids = extractCriticalIdentifiers(text);
      expect(ids.some((id) => id.includes("/home/ellie/ellie-dev"))).toBe(true);
    });

    test("extracts Windows file paths", () => {
      const text = "Modified C:\\Users\\Dave\\Documents\\project.txt";
      const ids = extractCriticalIdentifiers(text);
      expect(ids.some((id) => id.includes("C:\\"))).toBe(true);
    });

    test("extracts network endpoints", () => {
      const text = "Server running on localhost:3001 and 127.0.0.1:8080";
      const ids = extractCriticalIdentifiers(text);
      expect(ids).toContain("localhost:3001");
      expect(ids).toContain("127.0.0.1:8080");
    });

    test("extracts error codes", () => {
      const text = "Got HTTP 404 and database error 500";
      const ids = extractCriticalIdentifiers(text);
      expect(ids).toContain("404");
      expect(ids).toContain("500");
    });

    test("returns empty array for text without identifiers", () => {
      const text = "Just a simple sentence";
      const ids = extractCriticalIdentifiers(text);
      expect(ids.length).toBe(0);
    });

    test("returns empty array for undefined input", () => {
      const ids = extractCriticalIdentifiers(undefined);
      expect(ids).toEqual([]);
    });

    test("deduplicates repeated identifiers", () => {
      const text = "ELLIE-922 is related to ELLIE-922 work";
      const ids = extractCriticalIdentifiers(text);
      expect(ids.filter((id) => id === "ELLIE-922").length).toBe(1);
    });
  });

  describe("verifyWorkingMemorySurvived", () => {
    test("passes when all critical sections survive", async () => {
      // Setup: Create working memory with critical sections
      const sections: WorkingMemorySections = {
        session_identity: "Test session",
        context_anchors: "Critical: ELLIE-922, /home/ellie/file.ts, Error 404",
        decision_log: "Decision: Use Forest snapshots for rollback",
      };

      await initWorkingMemory({
        session_id: testSessionId + "-pass",
        agent: testAgent,
        sections,
      });

      // Create snapshot
      const snapshotId = await snapshotWorkingMemoryToForest({
        session_id: testSessionId + "-pass",
        agent: testAgent,
        scope_path: "2/1",
      });

      // Verify (no compaction happened, so everything should survive)
      const result = await verifyWorkingMemorySurvived({
        session_id: testSessionId + "-pass",
        agent: testAgent,
        pre_snapshot_memory_id: snapshotId ?? undefined,
      });

      expect(result.ok).toBe(true);
      expect(result.lost_sections).toBeUndefined();
      expect(result.lost_identifiers).toBeUndefined();
    });

    test("detects lost context_anchors section", async () => {
      // Setup: Create working memory with context_anchors
      await initWorkingMemory({
        session_id: testSessionId + "-lost-anchors",
        agent: testAgent,
        sections: {
          session_identity: "Test",
          context_anchors: "Critical: ELLIE-922, file.ts:123",
          decision_log: "Some decision",
        },
      });

      // Snapshot
      await snapshotWorkingMemoryToForest({
        session_id: testSessionId + "-lost-anchors",
        agent: testAgent,
      });

      // ELLIE-922: Unlock safeguard to simulate compaction modifying memory
      const { unlockSafeguard } = await import("../src/working-memory.ts");
      await unlockSafeguard({
        session_id: testSessionId + "-lost-anchors",
        agent: testAgent,
      });

      // Simulate compaction loss: remove context_anchors
      await updateWorkingMemory({
        session_id: testSessionId + "-lost-anchors",
        agent: testAgent,
        sections: {
          context_anchors: "", // Cleared during compaction
        },
      });

      // Verify
      const result = await verifyWorkingMemorySurvived({
        session_id: testSessionId + "-lost-anchors",
        agent: testAgent,
      });

      expect(result.ok).toBe(false);
      expect(result.lost_sections).toContain("context_anchors");
    });

    test("detects lost decision_log section", async () => {
      await initWorkingMemory({
        session_id: testSessionId + "-lost-log",
        agent: testAgent,
        sections: {
          session_identity: "Test",
          decision_log: "Important decision log",
        },
      });

      await snapshotWorkingMemoryToForest({
        session_id: testSessionId + "-lost-log",
        agent: testAgent,
      });

      // ELLIE-922: Unlock safeguard to simulate compaction modifying memory
      const { unlockSafeguard } = await import("../src/working-memory.ts");
      await unlockSafeguard({
        session_id: testSessionId + "-lost-log",
        agent: testAgent,
      });

      // Simulate loss
      await updateWorkingMemory({
        session_id: testSessionId + "-lost-log",
        agent: testAgent,
        sections: {
          decision_log: "",
        },
      });

      const result = await verifyWorkingMemorySurvived({
        session_id: testSessionId + "-lost-log",
        agent: testAgent,
      });

      expect(result.ok).toBe(false);
      expect(result.lost_sections).toContain("decision_log");
    });

    test("detects lost critical identifiers", async () => {
      await initWorkingMemory({
        session_id: testSessionId + "-lost-ids",
        agent: testAgent,
        sections: {
          context_anchors:
            "Working on ELLIE-922, modified /home/ellie/file.ts:123, error 404",
        },
      });

      await snapshotWorkingMemoryToForest({
        session_id: testSessionId + "-lost-ids",
        agent: testAgent,
      });

      // ELLIE-922: Unlock safeguard to simulate compaction modifying memory
      const { unlockSafeguard } = await import("../src/working-memory.ts");
      await unlockSafeguard({
        session_id: testSessionId + "-lost-ids",
        agent: testAgent,
      });

      // Simulate partial loss: keep section but lose specific identifiers
      await updateWorkingMemory({
        session_id: testSessionId + "-lost-ids",
        agent: testAgent,
        sections: {
          context_anchors: "Working on ticket, modified file", // Lost specifics
        },
      });

      const result = await verifyWorkingMemorySurvived({
        session_id: testSessionId + "-lost-ids",
        agent: testAgent,
      });

      expect(result.ok).toBe(false);
      expect(result.lost_identifiers).toBeTruthy();
      expect(result.lost_identifiers?.length).toBeGreaterThan(0);
    });

    test("returns ok when no snapshot exists", async () => {
      // No snapshot created, so verification can't happen
      await initWorkingMemory({
        session_id: testSessionId + "-no-snapshot",
        agent: testAgent,
        sections: { session_identity: "Test" },
      });

      const result = await verifyWorkingMemorySurvived({
        session_id: testSessionId + "-no-snapshot",
        agent: testAgent,
      });

      // Can't verify without snapshot, so returns ok (non-blocking)
      expect(result.ok).toBe(true);
    });

    test("detects complete working memory loss", async () => {
      await initWorkingMemory({
        session_id: testSessionId + "-complete-loss",
        agent: testAgent,
        sections: {
          context_anchors: "Critical data",
          decision_log: "Important decisions",
        },
      });

      await snapshotWorkingMemoryToForest({
        session_id: testSessionId + "-complete-loss",
        agent: testAgent,
      });

      // Simulate complete loss: archive working memory
      await sql`
        UPDATE working_memory
        SET archived_at = NOW()
        WHERE session_id = ${testSessionId + "-complete-loss"}
          AND agent = ${testAgent}
      `;

      const result = await verifyWorkingMemorySurvived({
        session_id: testSessionId + "-complete-loss",
        agent: testAgent,
      });

      expect(result.ok).toBe(false);
      expect(result.lost_sections).toContain("all");
    });
  });

  // ── Phase 3: Rollback Mechanism ────────────────────────────────────────────

  describe("rollbackWorkingMemoryFromSnapshot", () => {
    test("successfully restores working memory from snapshot", async () => {
      const originalSections: WorkingMemorySections = {
        session_identity: "Original session",
        context_anchors: "Critical: ELLIE-922, file.ts:123",
        decision_log: "Important decision that must survive",
      };

      // Create and snapshot
      await initWorkingMemory({
        session_id: testSessionId + "-rollback-ok",
        agent: testAgent,
        sections: originalSections,
      });

      await snapshotWorkingMemoryToForest({
        session_id: testSessionId + "-rollback-ok",
        agent: testAgent,
      });

      // ELLIE-922: Unlock safeguard to simulate compaction corruption
      const { unlockSafeguard } = await import("../src/working-memory.ts");
      await unlockSafeguard({
        session_id: testSessionId + "-rollback-ok",
        agent: testAgent,
      });

      // Simulate corruption: overwrite with garbage
      await updateWorkingMemory({
        session_id: testSessionId + "-rollback-ok",
        agent: testAgent,
        sections: {
          context_anchors: "",
          decision_log: "",
        },
      });

      // Rollback
      const success = await rollbackWorkingMemoryFromSnapshot({
        session_id: testSessionId + "-rollback-ok",
        agent: testAgent,
      });

      expect(success).toBe(true);

      // Verify restoration
      const { readWorkingMemory } = await import("../src/working-memory.ts");
      const restored = await readWorkingMemory({
        session_id: testSessionId + "-rollback-ok",
        agent: testAgent,
      });

      expect(restored).toBeTruthy();
      expect(restored?.sections.context_anchors).toContain("ELLIE-922");
      expect(restored?.sections.decision_log).toContain("Important decision");
    });

    test("creates audit trail entry on rollback", async () => {
      await initWorkingMemory({
        session_id: testSessionId + "-audit",
        agent: testAgent,
        sections: {
          context_anchors: "Test data",
        },
      });

      await snapshotWorkingMemoryToForest({
        session_id: testSessionId + "-audit",
        agent: testAgent,
      });

      // ELLIE-922: Unlock safeguard to simulate compaction corruption
      const { unlockSafeguard } = await import("../src/working-memory.ts");
      await unlockSafeguard({
        session_id: testSessionId + "-audit",
        agent: testAgent,
      });

      // Corrupt and rollback
      await updateWorkingMemory({
        session_id: testSessionId + "-audit",
        agent: testAgent,
        sections: { context_anchors: "" },
      });

      await rollbackWorkingMemoryFromSnapshot({
        session_id: testSessionId + "-audit",
        agent: testAgent,
      });

      // Verify audit trail was created
      const auditEntries = await sql`
        SELECT content, type, tags
        FROM shared_memories
        WHERE tags @> ARRAY['compaction_safeguard', 'rollback']::text[]
          AND metadata->>'session_id' = ${testSessionId + "-audit"}
          AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1
      `;

      expect(auditEntries.length).toBe(1);
      expect(auditEntries[0].type).toBe("fact");
      expect(auditEntries[0].content).toContain("rolled back");
      expect(auditEntries[0].content).toContain("compaction safeguard failure");
    });

    test("returns false when no snapshot exists", async () => {
      const success = await rollbackWorkingMemoryFromSnapshot({
        session_id: "nonexistent-session",
        agent: testAgent,
      });

      expect(success).toBe(false);
    });

    test("returns false when working memory record not found", async () => {
      // Create snapshot but no working memory
      await initWorkingMemory({
        session_id: testSessionId + "-no-wm",
        agent: testAgent,
        sections: { context_anchors: "Test" },
      });

      await snapshotWorkingMemoryToForest({
        session_id: testSessionId + "-no-wm",
        agent: testAgent,
      });

      // Archive working memory completely
      await sql`
        UPDATE working_memory
        SET archived_at = NOW()
        WHERE session_id = ${testSessionId + "-no-wm"}
          AND agent = ${testAgent}
      `;

      const success = await rollbackWorkingMemoryFromSnapshot({
        session_id: testSessionId + "-no-wm",
        agent: testAgent,
      });

      expect(success).toBe(false);
    });

    test("restores all 7 sections when present in snapshot", async () => {
      const allSections: WorkingMemorySections = {
        session_identity: "Full session",
        task_stack: "Task 1\nTask 2",
        conversation_thread: "User asked about X",
        investigation_state: "Examined file Y",
        decision_log: "Decided to use Z",
        context_anchors: "ELLIE-922, file.ts:123",
        resumption_prompt: "Continue from here",
      };

      await initWorkingMemory({
        session_id: testSessionId + "-all-sections",
        agent: testAgent,
        sections: allSections,
      });

      await snapshotWorkingMemoryToForest({
        session_id: testSessionId + "-all-sections",
        agent: testAgent,
      });

      // ELLIE-922: Unlock safeguard to simulate compaction corruption
      const { unlockSafeguard } = await import("../src/working-memory.ts");
      await unlockSafeguard({
        session_id: testSessionId + "-all-sections",
        agent: testAgent,
      });

      // Corrupt everything
      await updateWorkingMemory({
        session_id: testSessionId + "-all-sections",
        agent: testAgent,
        sections: {
          session_identity: "",
          task_stack: "",
          conversation_thread: "",
          investigation_state: "",
          decision_log: "",
          context_anchors: "",
          resumption_prompt: "",
        },
      });

      // Rollback
      await rollbackWorkingMemoryFromSnapshot({
        session_id: testSessionId + "-all-sections",
        agent: testAgent,
      });

      // Verify all sections restored
      const { readWorkingMemory } = await import("../src/working-memory.ts");
      const restored = await readWorkingMemory({
        session_id: testSessionId + "-all-sections",
        agent: testAgent,
      });

      expect(restored?.sections.session_identity).toContain("Full session");
      expect(restored?.sections.task_stack).toContain("Task 1");
      expect(restored?.sections.conversation_thread).toContain("User asked");
      expect(restored?.sections.investigation_state).toContain("Examined file");
      expect(restored?.sections.decision_log).toContain("Decided to use");
      expect(restored?.sections.context_anchors).toContain("ELLIE-922");
      expect(restored?.sections.resumption_prompt).toContain("Continue from");
    });
  });

  // ── Integration: Verify → Rollback Flow ────────────────────────────────────

  describe("End-to-End Safeguard Flow", () => {
    test("full cycle: snapshot → corruption → verify → rollback → verify", async () => {
      // 1. Initialize with critical data
      const criticalSections: WorkingMemorySections = {
        context_anchors: "ELLIE-922, /home/ellie/src/file.ts:123, Error 404",
        decision_log: "Decided to implement rollback mechanism",
      };

      await initWorkingMemory({
        session_id: testSessionId + "-e2e",
        agent: testAgent,
        sections: criticalSections,
      });

      // 2. Create pre-compaction snapshot
      const snapshotId = await snapshotWorkingMemoryToForest({
        session_id: testSessionId + "-e2e",
        agent: testAgent,
      });

      expect(snapshotId).toBeTruthy();

      // 3. Simulate compaction loss (bypass safeguard lock using direct SQL to test verification)
      // This simulates database-level corruption or bugs in compaction logic
      await sql`
        UPDATE working_memory
        SET
          sections = jsonb_set(
            jsonb_set(
              sections,
              '{context_anchors}',
              '"ELLIE-922, file.ts"'
            ),
            '{decision_log}',
            '""'
          ),
          turn_number = turn_number + 1
        WHERE session_id = ${testSessionId + "-e2e"}
          AND agent = ${testAgent}
          AND archived_at IS NULL
      `;

      // 4. Verify — should fail
      const verifyResult1 = await verifyWorkingMemorySurvived({
        session_id: testSessionId + "-e2e",
        agent: testAgent,
      });

      expect(verifyResult1.ok).toBe(false);
      expect(verifyResult1.lost_sections).toContain("decision_log");
      expect(verifyResult1.lost_identifiers).toBeTruthy();

      // 5. Rollback
      const rollbackSuccess = await rollbackWorkingMemoryFromSnapshot({
        session_id: testSessionId + "-e2e",
        agent: testAgent,
      });

      expect(rollbackSuccess).toBe(true);

      // 6. Verify again — should pass
      const verifyResult2 = await verifyWorkingMemorySurvived({
        session_id: testSessionId + "-e2e",
        agent: testAgent,
      });

      expect(verifyResult2.ok).toBe(true);

      // 7. Verify content restored correctly
      const { readWorkingMemory } = await import("../src/working-memory.ts");
      const final = await readWorkingMemory({
        session_id: testSessionId + "-e2e",
        agent: testAgent,
      });

      expect(final?.sections.context_anchors).toContain("Error 404");
      expect(final?.sections.decision_log).toContain("rollback mechanism");
    });
  });
});
