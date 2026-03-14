/**
 * Forest Integration Tests: Branches — ELLIE-712
 *
 * Tests branch CRUD, merge, abandon, listing.
 * Uses real test database (ellie-forest-test).
 */

process.env.DB_NAME = "ellie-forest-test";

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { createTree } from "../../ellie-forest/src/trees.ts";
import {
  createBranch, getBranch, mergeBranch, abandonBranch,
  listOpenBranches, getBranchByName, listBranches,
} from "../../ellie-forest/src/branches.ts";
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

async function makeTree() {
  const { tree, trunk } = await createTree({ type: "work_session", title: "Branch test" });
  return { tree, trunk };
}

describe("forest branches integration", () => {
  test("createBranch creates an open branch", async () => {
    const { tree, trunk } = await makeTree();
    const branch = await createBranch({
      tree_id: tree.id,
      trunk_id: trunk.id,
      name: "dev-branch",
    });

    expect(branch.tree_id).toBe(tree.id);
    expect(branch.state).toBe("open");
    expect(branch.name).toBe("dev-branch");
  });

  test("getBranch fetches by ID", async () => {
    const { tree, trunk } = await makeTree();
    const branch = await createBranch({
      tree_id: tree.id,
      trunk_id: trunk.id,
      name: "fetch-test",
    });

    const fetched = await getBranch(branch.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(branch.id);
  });

  test("getBranch returns null for nonexistent", async () => {
    const result = await getBranch("00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });

  test("mergeBranch sets state to merged", async () => {
    const { tree, trunk } = await makeTree();
    const branch = await createBranch({
      tree_id: tree.id,
      trunk_id: trunk.id,
      name: "merge-test",
    });

    const merged = await mergeBranch(branch.id, "Work completed");
    expect(merged.state).toBe("merged");
  });

  test("abandonBranch sets state to abandoned", async () => {
    const { tree, trunk } = await makeTree();
    const branch = await createBranch({
      tree_id: tree.id,
      trunk_id: trunk.id,
      name: "abandon-test",
    });

    const abandoned = await abandonBranch(branch.id, "No longer needed");
    expect(abandoned.state).toBe("abandoned");
  });

  test("listOpenBranches returns only open branches", async () => {
    const { tree, trunk } = await makeTree();
    await createBranch({ tree_id: tree.id, trunk_id: trunk.id, name: "open-1" });
    await createBranch({ tree_id: tree.id, trunk_id: trunk.id, name: "open-2" });
    const toMerge = await createBranch({ tree_id: tree.id, trunk_id: trunk.id, name: "merged-1" });
    await mergeBranch(toMerge.id);

    const open = await listOpenBranches(tree.id);
    expect(open.length).toBe(2);
    expect(open.every(b => b.state === "open")).toBe(true);
  });

  test("getBranchByName finds by exact name", async () => {
    const { tree, trunk } = await makeTree();
    await createBranch({ tree_id: tree.id, trunk_id: trunk.id, name: "creatures/dev" });

    const found = await getBranchByName(tree.id, "creatures/dev");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("creatures/dev");
  });

  test("getBranchByName returns null for nonexistent", async () => {
    const { tree } = await makeTree();
    const result = await getBranchByName(tree.id, "nonexistent");
    expect(result).toBeNull();
  });

  test("listBranches with prefix filter", async () => {
    const { tree, trunk } = await makeTree();
    await createBranch({ tree_id: tree.id, trunk_id: trunk.id, name: "creatures/dev" });
    await createBranch({ tree_id: tree.id, trunk_id: trunk.id, name: "creatures/research" });
    await createBranch({ tree_id: tree.id, trunk_id: trunk.id, name: "other-branch" });

    const creatures = await listBranches(tree.id, "creatures/");
    expect(creatures.length).toBe(2);
    expect(creatures.every(b => b.name.startsWith("creatures/"))).toBe(true);
  });
});
