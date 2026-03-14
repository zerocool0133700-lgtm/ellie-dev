/**
 * Forest Integration Tests: Events — ELLIE-712
 *
 * Tests event emission and querying.
 * Uses real test database (ellie-forest-test).
 */

process.env.DB_NAME = "ellie-forest-test";

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { createTree } from "../../ellie-forest/src/trees.ts";
import {
  emitEvent, getTreeEvents, getRecentActivity,
} from "../../ellie-forest/src/events.ts";
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

describe("forest events integration", () => {
  test("emitEvent creates event record", async () => {
    const { tree } = await createTree({ type: "conversation", title: "Event test" });

    const event = await emitEvent({
      kind: "tree.created",
      tree_id: tree.id,
      summary: "Tree was created",
      data: { type: "conversation" },
    });

    expect(event.kind).toBe("tree.created");
    expect(event.tree_id).toBe(tree.id);
    expect(event.summary).toBe("Tree was created");
  });

  test("getTreeEvents returns events for a tree", async () => {
    const { tree } = await createTree({ type: "conversation", title: "Multi-event" });

    // createTree already emits tree.created event
    const events = await getTreeEvents(tree.id);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].tree_id).toBe(tree.id);
  });

  test("getTreeEvents respects limit", async () => {
    const { tree } = await createTree({ type: "conversation", title: "Limit test" });
    // Add extra events
    for (let i = 0; i < 5; i++) {
      await emitEvent({
        kind: "tree.state_changed",
        tree_id: tree.id,
        summary: `Event ${i}`,
      });
    }

    const limited = await getTreeEvents(tree.id, 3);
    expect(limited.length).toBe(3);
  });

  test("getTreeEvents orders by created_at DESC", async () => {
    const { tree } = await createTree({ type: "conversation", title: "Order test" });
    await emitEvent({ kind: "tree.state_changed", tree_id: tree.id, summary: "First" });
    await emitEvent({ kind: "tree.state_changed", tree_id: tree.id, summary: "Second" });

    const events = await getTreeEvents(tree.id);
    // Most recent first
    const summaries = events.map(e => e.summary);
    expect(summaries.indexOf("Second")).toBeLessThan(summaries.indexOf("First"));
  });

  test("getRecentActivity returns global events", async () => {
    await createTree({ type: "conversation", title: "Activity 1" });
    await createTree({ type: "analysis", title: "Activity 2" });

    const recent = await getRecentActivity(10);
    expect(recent.length).toBeGreaterThanOrEqual(2);
  });
});
