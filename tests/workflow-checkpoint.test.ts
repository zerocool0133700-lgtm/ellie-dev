/**
 * ELLIE-834: Workflow checkpoint tables and API tests
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import {
  createInstance,
  getInstance,
  updateInstanceStatus,
  getInstancesByWorkItem,
  createCheckpoint,
  updateCheckpoint,
  getCheckpoints,
  getActiveCheckpointsForAgent,
  getLastCompletedStep,
} from "../src/workflow-checkpoint.ts";

const TEST_DB = "ellie-forest-test";
let sql: any;
const createdIds: string[] = [];

beforeAll(async () => {
  const postgres = (await import("postgres")).default;
  sql = postgres({ database: TEST_DB, host: "/var/run/postgresql", max: 3 });
});

afterAll(async () => {
  // Clean up test data
  for (const id of createdIds) {
    await sql`DELETE FROM workflow_checkpoints WHERE workflow_id = ${id}`.catch(() => {});
    await sql`DELETE FROM workflow_messages WHERE workflow_id = ${id}`.catch(() => {});
    await sql`DELETE FROM workflow_instances WHERE id = ${id}`.catch(() => {});
  }
  if (sql) await sql.end();
});

describe("ELLIE-834: Workflow checkpoint API", () => {

  describe("createInstance", () => {
    it("creates a workflow instance with defaults", async () => {
      const instance = await createInstance(sql, { work_item_id: "ELLIE-TEST-834" });
      createdIds.push(instance.id);
      expect(instance.id).toBeDefined();
      expect(instance.status).toBe("pending");
      expect(instance.current_step).toBe(0);
      expect(instance.work_item_id).toBe("ELLIE-TEST-834");
    });

    it("stores context as JSONB", async () => {
      const instance = await createInstance(sql, {
        work_item_id: "ELLIE-TEST-834-CTX",
        context: { workflow_name: "test-flow", source: "unit-test" },
      });
      createdIds.push(instance.id);
      expect(instance.context).toBeDefined();
    });
  });

  describe("getInstance", () => {
    it("retrieves an existing instance", async () => {
      const created = await createInstance(sql, { work_item_id: "ELLIE-TEST-834-GET" });
      createdIds.push(created.id);
      const fetched = await getInstance(sql, created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
    });

    it("returns null for non-existent ID", async () => {
      const result = await getInstance(sql, "00000000-0000-0000-0000-000000000000");
      expect(result).toBeNull();
    });
  });

  describe("updateInstanceStatus", () => {
    it("transitions to in_progress", async () => {
      const instance = await createInstance(sql, { work_item_id: "ELLIE-TEST-834-UPD" });
      createdIds.push(instance.id);
      await updateInstanceStatus(sql, instance.id, "in_progress", 1);
      const updated = await getInstance(sql, instance.id);
      expect(updated!.status).toBe("in_progress");
      expect(updated!.current_step).toBe(1);
    });

    it("sets completed_at on completion", async () => {
      const instance = await createInstance(sql, { work_item_id: "ELLIE-TEST-834-DONE" });
      createdIds.push(instance.id);
      await updateInstanceStatus(sql, instance.id, "completed");
      const updated = await getInstance(sql, instance.id);
      expect(updated!.status).toBe("completed");
      expect(updated!.completed_at).not.toBeNull();
    });
  });

  describe("checkpoint CRUD", () => {
    it("creates and retrieves checkpoints", async () => {
      const instance = await createInstance(sql, { work_item_id: "ELLIE-TEST-834-CP" });
      createdIds.push(instance.id);

      const cp = await createCheckpoint(sql, {
        workflow_id: instance.id,
        step: 0,
        agent: "dev",
        input: { task: "implement feature" },
      });

      expect(cp.step).toBe(0);
      expect(cp.agent).toBe("dev");
      expect(cp.status).toBe("in_progress");

      const all = await getCheckpoints(sql, instance.id);
      expect(all.length).toBe(1);
    });

    it("updates checkpoint status to completed", async () => {
      const instance = await createInstance(sql, { work_item_id: "ELLIE-TEST-834-CP2" });
      createdIds.push(instance.id);

      await createCheckpoint(sql, { workflow_id: instance.id, step: 0, agent: "research" });
      const updated = await updateCheckpoint(sql, instance.id, 0, {
        status: "completed",
        output: { findings: "test results" },
      });

      expect(updated!.status).toBe("completed");
      expect(updated!.completed_at).not.toBeNull();
    });

    it("upserts on conflict (same workflow_id + step)", async () => {
      const instance = await createInstance(sql, { work_item_id: "ELLIE-TEST-834-UPSERT" });
      createdIds.push(instance.id);

      await createCheckpoint(sql, { workflow_id: instance.id, step: 0, agent: "dev" });
      const cp2 = await createCheckpoint(sql, { workflow_id: instance.id, step: 0, agent: "research" });

      expect(cp2.agent).toBe("research"); // Updated
      const all = await getCheckpoints(sql, instance.id);
      expect(all.length).toBe(1); // Still just one
    });
  });

  describe("getActiveCheckpointsForAgent", () => {
    it("finds active checkpoints for an agent", async () => {
      const instance = await createInstance(sql, { work_item_id: "ELLIE-TEST-834-ACTIVE" });
      createdIds.push(instance.id);
      await updateInstanceStatus(sql, instance.id, "in_progress");
      await createCheckpoint(sql, { workflow_id: instance.id, step: 0, agent: "dev" });

      const active = await getActiveCheckpointsForAgent(sql, "dev");
      expect(active.some(cp => cp.workflow_id === instance.id)).toBe(true);
    });
  });

  describe("getLastCompletedStep", () => {
    it("returns -1 when no steps completed", async () => {
      const instance = await createInstance(sql, { work_item_id: "ELLIE-TEST-834-LAST" });
      createdIds.push(instance.id);
      const last = await getLastCompletedStep(sql, instance.id);
      expect(last).toBe(-1);
    });

    it("returns highest completed step", async () => {
      const instance = await createInstance(sql, { work_item_id: "ELLIE-TEST-834-LAST2" });
      createdIds.push(instance.id);

      await createCheckpoint(sql, { workflow_id: instance.id, step: 0, agent: "research" });
      await updateCheckpoint(sql, instance.id, 0, { status: "completed" });
      await createCheckpoint(sql, { workflow_id: instance.id, step: 1, agent: "dev" });
      await updateCheckpoint(sql, instance.id, 1, { status: "completed" });
      await createCheckpoint(sql, { workflow_id: instance.id, step: 2, agent: "critic" });
      // Step 2 still in_progress

      const last = await getLastCompletedStep(sql, instance.id);
      expect(last).toBe(1);
    });
  });
});
