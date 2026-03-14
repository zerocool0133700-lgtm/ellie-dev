/**
 * Forest Integration Tests: Entities — ELLIE-712
 *
 * Tests entity lookup, filtering, and tree attachment.
 * Uses real test database (ellie-forest-test) with seeded entities.
 */

process.env.DB_NAME = "ellie-forest-test";

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { createTree } from "../../ellie-forest/src/trees.ts";
import {
  getEntity, getEntitiesByNames, getEntitiesByIds,
  listEntities, attachEntity, detachEntity, getEntityWorkload,
} from "../../ellie-forest/src/entities.ts";
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

describe("forest entities integration", () => {
  test("getEntity by name", async () => {
    const entity = await getEntity("dev_agent");
    expect(entity).not.toBeNull();
    expect(entity!.name).toBe("dev_agent");
    expect(entity!.type).toBe("agent");
  });

  test("getEntity returns null for nonexistent", async () => {
    const entity = await getEntity("nonexistent_agent_xyz");
    expect(entity).toBeNull();
  });

  test("getEntitiesByNames batch lookup", async () => {
    const map = await getEntitiesByNames(["dev_agent", "research_agent"]);
    expect(map.size).toBe(2);
    expect(map.has("dev_agent")).toBe(true);
    expect(map.has("research_agent")).toBe(true);
  });

  test("listEntities returns active entities", async () => {
    const entities = await listEntities();
    expect(entities.length).toBeGreaterThan(0);
    expect(entities.every(e => e.active)).toBe(true);
  });

  test("listEntities filtered by type", async () => {
    const agents = await listEntities({ type: "agent" });
    expect(agents.length).toBeGreaterThan(0);
    expect(agents.every(e => e.type === "agent")).toBe(true);
  });

  test("attachEntity and detachEntity", async () => {
    const { tree } = await createTree({ type: "work_session", title: "Attach test" });
    const entity = await getEntity("dev_agent");
    expect(entity).not.toBeNull();

    const te = await attachEntity(tree.id, entity!.id, "contributor");
    expect(te.tree_id).toBe(tree.id);
    expect(te.entity_id).toBe(entity!.id);

    await detachEntity(tree.id, entity!.id);
    // After detach, should not appear in active workload
    const workload = await getEntityWorkload(entity!.id);
    expect(workload.active_trees).toBe(0);
  });

  test("getEntityWorkload counts correctly", async () => {
    const entity = await getEntity("dev_agent");
    expect(entity).not.toBeNull();

    // Start with clean slate
    const before = await getEntityWorkload(entity!.id);
    expect(before.active_trees).toBe(0);

    // Attach to a tree
    const { tree } = await createTree({ type: "work_session", title: "Workload test" });
    await attachEntity(tree.id, entity!.id);

    const after = await getEntityWorkload(entity!.id);
    expect(after.active_trees).toBe(1);
  });
});
