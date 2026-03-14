/**
 * Forest Integration Tests: Creatures — ELLIE-712
 *
 * Tests creature dispatch, state transitions, and querying.
 * Uses real test database (ellie-forest-test).
 */

process.env.DB_NAME = "ellie-forest-test";

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { createTree } from "../../ellie-forest/src/trees.ts";
import { createBranch } from "../../ellie-forest/src/branches.ts";
import { getEntity } from "../../ellie-forest/src/entities.ts";
import {
  dispatchCreature, startCreature, completeCreature,
  failCreature, getCreature, getActiveCreatures,
} from "../../ellie-forest/src/creatures.ts";
import sql from "../../ellie-forest/src/db.ts";

async function cleanTables() {
  await sql`DELETE FROM shared_memories`;
  await sql`DELETE FROM forest_events`;
  await sql`DELETE FROM creatures`;
  await sql`UPDATE branches SET head_commit_id = NULL`;
  await sql`UPDATE trunks SET head_commit_id = NULL`;
  await sql`DELETE FROM commits`;
  await sql`DELETE FROM branches`;
  await sql`DELETE FROM trunks`;
  await sql`DELETE FROM tree_entities`;
  await sql`DELETE FROM contribution_policies`;
  await sql`DELETE FROM trees`;
}

beforeEach(async () => { await cleanTables(); });
afterAll(async () => { await cleanTables(); });

async function makeTreeAndBranch() {
  const { tree, trunk } = await createTree({ type: "work_session", title: "Creature test" });
  const branch = await createBranch({ tree_id: tree.id, trunk_id: trunk.id, name: "creatures/dev" });
  const entity = await getEntity("dev_agent");
  return { tree, trunk, branch, entityId: entity!.id };
}

describe("forest creatures integration", () => {
  test("dispatchCreature creates a dispatched creature", async () => {
    const { tree, branch, entityId } = await makeTreeAndBranch();

    const creature = await dispatchCreature({
      tree_id: tree.id,
      branch_id: branch.id,
      entity_id: entityId,
      type: "pull",
      intent: "Build the feature",
    });

    expect(creature.state).toBe("dispatched");
    expect(creature.type).toBe("pull");
    expect(creature.tree_id).toBe(tree.id);
    expect(creature.branch_id).toBe(branch.id);
    expect(creature.entity_id).toBe(entityId);
  });

  test("startCreature transitions to working", async () => {
    const { tree, branch, entityId } = await makeTreeAndBranch();
    const creature = await dispatchCreature({
      tree_id: tree.id,
      branch_id: branch.id,
      entity_id: entityId,
      type: "pull",
      intent: "Test start",
    });

    const started = await startCreature(creature.id);
    expect(started.state).toBe("working");
  });

  test("completeCreature transitions to completed", async () => {
    const { tree, branch, entityId } = await makeTreeAndBranch();
    const creature = await dispatchCreature({
      tree_id: tree.id,
      branch_id: branch.id,
      entity_id: entityId,
      type: "pull",
      intent: "Test complete",
    });
    await startCreature(creature.id);

    const completed = await completeCreature(creature.id, "All done");
    expect(completed.state).toBe("completed");
    expect(completed.result).toBe("All done");
  });

  test("failCreature transitions to failed", async () => {
    const { tree, branch, entityId } = await makeTreeAndBranch();
    const creature = await dispatchCreature({
      tree_id: tree.id,
      branch_id: branch.id,
      entity_id: entityId,
      type: "pull",
      intent: "Test fail",
    });
    await startCreature(creature.id);

    const failed = await failCreature(creature.id, "Build error");
    expect(failed.state).toBe("failed");
    expect(failed.error).toBe("Build error");
  });

  test("getCreature fetches by ID", async () => {
    const { tree, branch, entityId } = await makeTreeAndBranch();
    const creature = await dispatchCreature({
      tree_id: tree.id,
      branch_id: branch.id,
      entity_id: entityId,
      type: "pull",
      intent: "Fetch test",
    });

    const fetched = await getCreature(creature.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(creature.id);
  });

  test("getCreature returns null for nonexistent", async () => {
    const result = await getCreature("00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });

  test("getActiveCreatures returns dispatched/working creatures", async () => {
    const { tree, branch, entityId } = await makeTreeAndBranch();
    await dispatchCreature({ tree_id: tree.id, branch_id: branch.id, entity_id: entityId, type: "pull", intent: "Active 1" });
    await dispatchCreature({ tree_id: tree.id, branch_id: branch.id, entity_id: entityId, type: "push", intent: "Active 2" });

    const active = await getActiveCreatures(tree.id);
    expect(active.length).toBe(2);
  });

  test("completed creatures not in getActiveCreatures", async () => {
    const { tree, branch, entityId } = await makeTreeAndBranch();
    const c = await dispatchCreature({ tree_id: tree.id, branch_id: branch.id, entity_id: entityId, type: "pull", intent: "Complete me" });
    await startCreature(c.id);
    await completeCreature(c.id, "Done");

    const active = await getActiveCreatures(tree.id);
    expect(active.length).toBe(0);
  });
});
