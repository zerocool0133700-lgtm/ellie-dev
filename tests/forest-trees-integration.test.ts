/**
 * Forest Integration Tests: Trees — ELLIE-712
 *
 * Tests tree lifecycle: create, read, state transitions, close.
 * Uses real test database (ellie-forest-test).
 */

// Force test database BEFORE any imports
process.env.DB_NAME = "ellie-forest-test";

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import {
  createTree, getTree, getTreesByIds, promoteTree, closeTree,
  updateTreeState, listActiveTrees, getTrunk, createTrunk,
} from "../../ellie-forest/src/trees.ts";
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

describe("forest trees integration", () => {
  test("createTree returns tree and trunk", async () => {
    const { tree, trunk } = await createTree({
      type: "conversation",
      title: "Test conversation",
    });

    expect(tree.type).toBe("conversation");
    expect(tree.state).toBe("nursery");
    expect(tree.title).toBe("Test conversation");
    expect(trunk.tree_id).toBe(tree.id);
    expect(trunk.is_primary).toBe(true);
  });

  test("createTree with work_item_id and tags", async () => {
    const { tree } = await createTree({
      type: "work_session",
      title: "ELLIE-712 work",
      work_item_id: "ELLIE-712",
      tags: ["testing", "forest"],
    });

    expect(tree.work_item_id).toBe("ELLIE-712");
    expect(tree.tags).toContain("testing");
    expect(tree.tags).toContain("forest");
  });

  test("getTree fetches by ID", async () => {
    const { tree } = await createTree({ type: "analysis", title: "Test" });
    const fetched = await getTree(tree.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(tree.id);
    expect(fetched!.title).toBe("Test");
  });

  test("getTree returns null for nonexistent", async () => {
    const result = await getTree("00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });

  test("getTreesByIds batch fetch", async () => {
    const { tree: t1 } = await createTree({ type: "conversation", title: "One" });
    const { tree: t2 } = await createTree({ type: "analysis", title: "Two" });

    const map = await getTreesByIds([t1.id, t2.id]);
    expect(map.size).toBe(2);
    expect(map.get(t1.id)!.title).toBe("One");
    expect(map.get(t2.id)!.title).toBe("Two");
  });

  test("promoteTree transitions from nursery", async () => {
    const { tree } = await createTree({ type: "conversation", title: "Promote me" });
    expect(tree.state).toBe("nursery");

    const promoted = await promoteTree(tree.id);
    expect(promoted.state).toBe("seedling");
  });

  test("updateTreeState changes state", async () => {
    const { tree } = await createTree({ type: "conversation", title: "State test" });
    const updated = await updateTreeState(tree.id, "seedling");
    expect(updated.state).toBe("seedling");
  });

  test("listActiveTrees returns non-archived trees", async () => {
    await createTree({ type: "conversation", title: "Active 1" });
    await createTree({ type: "analysis", title: "Active 2" });

    const active = await listActiveTrees();
    expect(active.length).toBeGreaterThanOrEqual(2);
  });

  test("getTrunk returns primary trunk", async () => {
    const { tree, trunk: created } = await createTree({ type: "conversation", title: "Trunk test" });
    const trunk = await getTrunk(tree.id);
    expect(trunk).not.toBeNull();
    expect(trunk!.id).toBe(created.id);
    expect(trunk!.is_primary).toBe(true);
  });

  test("createTrunk adds secondary trunk", async () => {
    const { tree } = await createTree({ type: "project", title: "Multi-trunk" });
    const trunk = await createTrunk(tree.id, "feature-branch", "feature/test");
    expect(trunk.name).toBe("feature-branch");
    expect(trunk.git_branch).toBe("feature/test");
    expect(trunk.is_primary).toBe(false);
  });
});
