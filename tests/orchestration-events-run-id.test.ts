/**
 * Verify orchestration_events accepts both UUID and dsp_* envelope IDs as run_id.
 * Regression test for the dispatch event UUID mismatch bug.
 */

process.env.DB_NAME = "ellie-forest-test";

import { describe, test, expect, afterAll } from "bun:test";
import sql from "../../ellie-forest/src/db.ts";

const insertedIds: string[] = [];

afterAll(async () => {
  if (insertedIds.length > 0) {
    await sql`DELETE FROM orchestration_events WHERE id = ANY(${insertedIds}::uuid[])`;
  }
});

describe("orchestration_events run_id column", () => {
  test("accepts UUID run_id", async () => {
    const [row] = await sql`
      INSERT INTO orchestration_events (run_id, event_type, agent_type, work_item_id, payload)
      VALUES (${crypto.randomUUID()}, 'dispatched', 'james', 'ELLIE-TEST', '{}')
      RETURNING id, run_id
    `;
    insertedIds.push(row.id);
    expect(row.run_id).toBeTruthy();
  });

  test("accepts dsp_ prefixed run_id", async () => {
    const dspId = `dsp_${Date.now().toString(36)}0001${Math.random().toString(36).slice(2, 6)}`;
    const [row] = await sql`
      INSERT INTO orchestration_events (run_id, event_type, agent_type, work_item_id, payload)
      VALUES (${dspId}, 'dispatched', 'james', 'ELLIE-TEST', '{}')
      RETURNING id, run_id
    `;
    insertedIds.push(row.id);
    expect(row.run_id).toBe(dspId);
  });

  test("events with dsp_ run_id are queryable", async () => {
    const dspId = `dsp_test_query_${Date.now()}`;
    const [inserted] = await sql`
      INSERT INTO orchestration_events (run_id, event_type, agent_type, payload)
      VALUES (${dspId}, 'dispatched', 'kate', '{}')
      RETURNING id
    `;
    insertedIds.push(inserted.id);

    const rows = await sql`
      SELECT * FROM orchestration_events WHERE run_id = ${dspId}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].agent_type).toBe("kate");
  });
});
