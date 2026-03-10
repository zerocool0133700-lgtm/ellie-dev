/**
 * Mountain Records Tests — ELLIE-663
 *
 * Tests the mountain_records repository: insert, upsert, get,
 * list with filters, status updates, and count.
 * Runs against the live Forest database.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import postgres from "postgres";
import {
  insertRecord,
  upsertRecord,
  getRecord,
  getRecordByExternalId,
  listRecords,
  updateRecordStatus,
  countRecords,
} from "../src/mountain/records.ts";

// ── Setup: clean mountain_records between tests ─────────────

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres({
    host: "/var/run/postgresql",
    database: "ellie-forest",
    username: "ellie",
  });
});

afterAll(async () => {
  // Clean up test data
  await sql`DELETE FROM mountain_records WHERE source_system = 'test-system'`;
  await sql.end();
});

beforeEach(async () => {
  await sql`DELETE FROM mountain_records WHERE source_system = 'test-system'`;
});

// ── Helpers ──────────────────────────────────────────────────

function testRecord(overrides: Record<string, unknown> = {}) {
  return {
    record_type: "billing",
    source_system: "test-system",
    external_id: `ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    payload: { amount: 100, patient: "Test Patient" },
    summary: "Test billing record",
    ...overrides,
  };
}

// ── insertRecord ─────────────────────────────────────────────

describe("insertRecord", () => {
  test("inserts a record and returns it", async () => {
    const rec = testRecord();
    const result = await insertRecord(rec);

    expect(result.id).toBeDefined();
    expect(result.record_type).toBe("billing");
    expect(result.source_system).toBe("test-system");
    expect(result.external_id).toBe(rec.external_id);
    expect(result.payload).toEqual(rec.payload);
    expect(result.summary).toBe("Test billing record");
    expect(result.status).toBe("active");
    expect(result.version).toBe(1);
    expect(result.created_at).toBeInstanceOf(Date);
  });

  test("defaults status to active", async () => {
    const result = await insertRecord(testRecord());
    expect(result.status).toBe("active");
  });

  test("accepts a custom status", async () => {
    const result = await insertRecord(testRecord({ status: "pending" }));
    expect(result.status).toBe("pending");
  });

  test("throws on duplicate (source_system, external_id)", async () => {
    const rec = testRecord();
    await insertRecord(rec);
    await expect(insertRecord(rec)).rejects.toThrow();
  });
});

// ── upsertRecord ─────────────────────────────────────────────

describe("upsertRecord", () => {
  test("inserts when no conflict", async () => {
    const rec = testRecord();
    const result = await upsertRecord(rec);
    expect(result.version).toBe(1);
    expect(result.payload).toEqual(rec.payload);
  });

  test("updates payload and bumps version on conflict", async () => {
    const rec = testRecord();
    const v1 = await upsertRecord(rec);
    expect(v1.version).toBe(1);

    const updated = await upsertRecord({
      ...rec,
      payload: { amount: 200, patient: "Updated Patient" },
      summary: "Updated summary",
    });
    expect(updated.id).toBe(v1.id);
    expect(updated.version).toBe(2);
    expect(updated.payload).toEqual({ amount: 200, patient: "Updated Patient" });
    expect(updated.summary).toBe("Updated summary");
  });

  test("preserves the same ID across upserts", async () => {
    const rec = testRecord();
    const v1 = await upsertRecord(rec);
    const v2 = await upsertRecord({ ...rec, payload: { changed: true } });
    expect(v2.id).toBe(v1.id);
  });
});

// ── getRecord ────────────────────────────────────────────────

describe("getRecord", () => {
  test("returns a record by ID", async () => {
    const inserted = await insertRecord(testRecord());
    const found = await getRecord(inserted.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(inserted.id);
    expect(found!.external_id).toBe(inserted.external_id);
  });

  test("returns null for unknown ID", async () => {
    const found = await getRecord("00000000-0000-0000-0000-000000000000");
    expect(found).toBeNull();
  });
});

// ── getRecordByExternalId ────────────────────────────────────

describe("getRecordByExternalId", () => {
  test("finds a record by source_system + external_id", async () => {
    const rec = testRecord();
    await insertRecord(rec);
    const found = await getRecordByExternalId("test-system", rec.external_id);
    expect(found).not.toBeNull();
    expect(found!.record_type).toBe("billing");
  });

  test("returns null for nonexistent combo", async () => {
    const found = await getRecordByExternalId("test-system", "nonexistent");
    expect(found).toBeNull();
  });
});

// ── listRecords ──────────────────────────────────────────────

describe("listRecords", () => {
  test("lists all records for a source", async () => {
    await insertRecord(testRecord({ record_type: "billing" }));
    await insertRecord(testRecord({ record_type: "visit" }));
    await insertRecord(testRecord({ record_type: "schedule" }));

    const all = await listRecords({ source_system: "test-system" });
    expect(all.length).toBe(3);
  });

  test("filters by record_type", async () => {
    await insertRecord(testRecord({ record_type: "billing" }));
    await insertRecord(testRecord({ record_type: "visit" }));

    const billing = await listRecords({
      source_system: "test-system",
      record_type: "billing",
    });
    expect(billing.length).toBe(1);
    expect(billing[0].record_type).toBe("billing");
  });

  test("filters by status", async () => {
    await insertRecord(testRecord({ status: "active" }));
    await insertRecord(testRecord({ status: "pending" }));

    const active = await listRecords({
      source_system: "test-system",
      status: "active",
    });
    expect(active.length).toBe(1);
    expect(active[0].status).toBe("active");
  });

  test("respects limit and offset", async () => {
    for (let i = 0; i < 5; i++) {
      await insertRecord(testRecord());
    }
    const page = await listRecords({
      source_system: "test-system",
      limit: 2,
      offset: 0,
    });
    expect(page.length).toBe(2);
  });

  test("returns results ordered by created_at DESC", async () => {
    const r1 = await insertRecord(testRecord());
    const r2 = await insertRecord(testRecord());
    const r3 = await insertRecord(testRecord());

    const list = await listRecords({ source_system: "test-system" });
    // Most recent first
    expect(list[0].id).toBe(r3.id);
    expect(list[2].id).toBe(r1.id);
  });
});

// ── updateRecordStatus ───────────────────────────────────────

describe("updateRecordStatus", () => {
  test("updates status and returns updated record", async () => {
    const rec = await insertRecord(testRecord());
    const updated = await updateRecordStatus(rec.id, "archived");
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("archived");
    expect(updated!.updated_at.getTime()).toBeGreaterThanOrEqual(
      rec.updated_at.getTime(),
    );
  });

  test("returns null for unknown ID", async () => {
    const result = await updateRecordStatus(
      "00000000-0000-0000-0000-000000000000",
      "archived",
    );
    expect(result).toBeNull();
  });
});

// ── countRecords ─────────────────────────────────────────────

describe("countRecords", () => {
  test("counts all records for a source", async () => {
    await insertRecord(testRecord());
    await insertRecord(testRecord());
    const count = await countRecords({ source_system: "test-system" });
    expect(count).toBe(2);
  });

  test("counts with type filter", async () => {
    await insertRecord(testRecord({ record_type: "billing" }));
    await insertRecord(testRecord({ record_type: "visit" }));
    await insertRecord(testRecord({ record_type: "billing" }));

    const billingCount = await countRecords({
      source_system: "test-system",
      record_type: "billing",
    });
    expect(billingCount).toBe(2);
  });

  test("counts with status filter", async () => {
    await insertRecord(testRecord({ status: "active" }));
    await insertRecord(testRecord({ status: "pending" }));
    const activeCount = await countRecords({
      source_system: "test-system",
      status: "active",
    });
    expect(activeCount).toBe(1);
  });
});

// ── Schema validation ────────────────────────────────────────

describe("schema", () => {
  test("unique constraint on (source_system, external_id) works", async () => {
    const rec = testRecord();
    await insertRecord(rec);
    // Same source_system + external_id should fail
    await expect(insertRecord(rec)).rejects.toThrow();
    // Different source_system with same external_id should succeed
    await insertRecord({ ...rec, source_system: "test-system-2" });
  });

  test("JSONB payload supports nested objects", async () => {
    const payload = {
      patient: { name: "Test", dob: "2020-01-01" },
      codes: ["99213", "90471"],
      charges: { total: 285, insurance: 228, copay: 57 },
    };
    const rec = await insertRecord(testRecord({ payload }));
    const found = await getRecord(rec.id);
    expect(found!.payload).toEqual(payload);
  });

  test("source_timestamp is stored correctly", async () => {
    const ts = new Date("2026-03-05T14:30:00Z");
    const rec = await insertRecord(
      testRecord({ source_timestamp: ts }),
    );
    const found = await getRecord(rec.id);
    expect(found!.source_timestamp!.getTime()).toBe(ts.getTime());
  });
});
