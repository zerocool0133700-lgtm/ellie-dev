/**
 * ELLIE-647 — Mountain: Knowledge curation workflow
 *
 * Tests approve/reject, inline editing, memory tier, bulk actions,
 * filtering, and curation stats.
 */

import { describe, test, expect, afterAll } from "bun:test";
import {
  ingestCleanedData, processRecord,
  createDomainModel, tagCleanedDataWithDomain,
  approveEntry, rejectEntry, markNeedsEditing, resetToPending,
  editEntry, setMemoryTier, promoteToCoreTier, demoteToExtendedTier,
  bulkApprove, bulkReject, bulkSetTier,
  listCuratedEntries, getCurationStats, getCuratedEntry,
} from "../../ellie-forest/src/index";
import sql from "../../ellie-forest/src/db";

const createdDataIds: string[] = [];
const createdModelIds: string[] = [];

afterAll(async () => {
  if (createdDataIds.length > 0) {
    await sql`UPDATE cleaned_data SET domain_model_id = NULL WHERE id = ANY(${createdDataIds})`;
    await sql`DELETE FROM cleaned_data_chunks WHERE cleaned_data_id = ANY(${createdDataIds})`;
    await sql`DELETE FROM cleaned_data WHERE id = ANY(${createdDataIds})`;
  }
  if (createdModelIds.length > 0) {
    await sql`DELETE FROM domain_model_sources WHERE domain_model_id = ANY(${createdModelIds})`;
    await sql`DELETE FROM domain_models WHERE id = ANY(${createdModelIds})`;
  }
});

/** Helper: create and process a test record */
async function createTestEntry(suffix: string, domainModelId?: string) {
  const record = await ingestCleanedData({
    connectorName: "test-647",
    sourceId: `test-647-${suffix}`,
    content: `Content for curation test: ${suffix}`,
    title: `Test Entry ${suffix}`,
    domainModelId,
  });
  createdDataIds.push(record.id);
  await processRecord(record.id);
  return record;
}

// ── Single Entry Actions ─────────────────────────────────

describe("approveEntry", () => {
  test("sets curation_status to approved", async () => {
    const entry = await createTestEntry("approve-1");
    const result = await approveEntry(entry.id, "Looks good");
    expect(result).not.toBeNull();
    expect(result!.curation_status).toBe("approved");
    expect(result!.curator_notes).toBe("Looks good");
    expect(result!.curated_at).toBeInstanceOf(Date);
  });

  test("returns null for unknown ID", async () => {
    const result = await approveEntry("00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });
});

describe("rejectEntry", () => {
  test("sets curation_status to rejected", async () => {
    const entry = await createTestEntry("reject-1");
    const result = await rejectEntry(entry.id, "Low quality");
    expect(result).not.toBeNull();
    expect(result!.curation_status).toBe("rejected");
    expect(result!.curator_notes).toBe("Low quality");
    expect(result!.curated_at).toBeInstanceOf(Date);
  });
});

describe("markNeedsEditing", () => {
  test("sets curation_status to needs_editing", async () => {
    const entry = await createTestEntry("needs-edit-1");
    const result = await markNeedsEditing(entry.id, "Fix typos in content");
    expect(result).not.toBeNull();
    expect(result!.curation_status).toBe("needs_editing");
    expect(result!.curator_notes).toBe("Fix typos in content");
  });
});

describe("resetToPending", () => {
  test("resets approved entry back to pending_review", async () => {
    const entry = await createTestEntry("reset-1");
    await approveEntry(entry.id, "Initially approved");
    const result = await resetToPending(entry.id);
    expect(result).not.toBeNull();
    expect(result!.curation_status).toBe("pending_review");
    expect(result!.curated_at).toBeNull();
    expect(result!.curator_notes).toBeNull();
  });
});

// ── Inline Editing ──────────────────────────────────────

describe("editEntry", () => {
  test("updates content", async () => {
    const entry = await createTestEntry("edit-content");
    const result = await editEntry(entry.id, { content: "Updated content here" });
    expect(result).not.toBeNull();
    expect(result!.content).toBe("Updated content here");
  });

  test("updates title", async () => {
    const entry = await createTestEntry("edit-title");
    const result = await editEntry(entry.id, { title: "New Title" });
    expect(result).not.toBeNull();
    expect(result!.title).toBe("New Title");
  });

  test("merges metadata", async () => {
    const entry = await createTestEntry("edit-meta");
    const result = await editEntry(entry.id, {
      metadata: { tags: ["important"], reviewed: true },
    });
    expect(result).not.toBeNull();
    expect(result!.metadata.tags).toEqual(["important"]);
    expect(result!.metadata.reviewed).toBe(true);
  });

  test("returns null for unknown ID", async () => {
    const result = await editEntry("00000000-0000-0000-0000-000000000000", {
      content: "nope",
    });
    expect(result).toBeNull();
  });
});

// ── Memory Tier ────────────────────────────────────────

describe("setMemoryTier", () => {
  test("sets tier to core", async () => {
    const entry = await createTestEntry("tier-core");
    const result = await setMemoryTier(entry.id, "core");
    expect(result).not.toBeNull();
    expect(result!.memory_tier).toBe("core");
  });

  test("sets tier to extended", async () => {
    const entry = await createTestEntry("tier-extended");
    const result = await setMemoryTier(entry.id, "extended");
    expect(result).not.toBeNull();
    expect(result!.memory_tier).toBe("extended");
  });

  test("returns null for unknown ID", async () => {
    const result = await setMemoryTier("00000000-0000-0000-0000-000000000000", "core");
    expect(result).toBeNull();
  });
});

describe("promoteToCoreTier", () => {
  test("promotes to core", async () => {
    const entry = await createTestEntry("promote-core");
    const result = await promoteToCoreTier(entry.id);
    expect(result!.memory_tier).toBe("core");
  });
});

describe("demoteToExtendedTier", () => {
  test("demotes to extended", async () => {
    const entry = await createTestEntry("demote-ext");
    await promoteToCoreTier(entry.id);
    const result = await demoteToExtendedTier(entry.id);
    expect(result!.memory_tier).toBe("extended");
  });
});

// ── Bulk Actions ────────────────────────────────────────

describe("bulkApprove", () => {
  test("approves multiple entries", async () => {
    const e1 = await createTestEntry("bulk-approve-1");
    const e2 = await createTestEntry("bulk-approve-2");
    const e3 = await createTestEntry("bulk-approve-3");

    const result = await bulkApprove([e1.id, e2.id, e3.id], "Batch approved");
    expect(result.updated).toBe(3);

    const fetched = await getCuratedEntry(e1.id);
    expect(fetched!.curation_status).toBe("approved");
    expect(fetched!.curator_notes).toBe("Batch approved");
  });

  test("handles empty array", async () => {
    const result = await bulkApprove([]);
    expect(result.updated).toBe(0);
  });
});

describe("bulkReject", () => {
  test("rejects multiple entries", async () => {
    const e1 = await createTestEntry("bulk-reject-1");
    const e2 = await createTestEntry("bulk-reject-2");

    const result = await bulkReject([e1.id, e2.id], "Spam content");
    expect(result.updated).toBe(2);

    const fetched = await getCuratedEntry(e2.id);
    expect(fetched!.curation_status).toBe("rejected");
  });
});

describe("bulkSetTier", () => {
  test("sets tier for multiple entries", async () => {
    const e1 = await createTestEntry("bulk-tier-1");
    const e2 = await createTestEntry("bulk-tier-2");

    const result = await bulkSetTier([e1.id, e2.id], "core");
    expect(result.updated).toBe(2);

    const fetched = await getCuratedEntry(e1.id);
    expect(fetched!.memory_tier).toBe("core");
  });
});

// ── Queries ─────────────────────────────────────────────

describe("listCuratedEntries", () => {
  test("returns entries with no filter", async () => {
    const entries = await listCuratedEntries();
    expect(Array.isArray(entries)).toBe(true);
  });

  test("filters by curation status", async () => {
    const entry = await createTestEntry("list-status");
    await approveEntry(entry.id);

    const approved = await listCuratedEntries({ curationStatus: "approved" });
    expect(approved.some(e => e.id === entry.id)).toBe(true);

    const rejected = await listCuratedEntries({ curationStatus: "rejected" });
    expect(rejected.some(e => e.id === entry.id)).toBe(false);
  });

  test("filters by domain model", async () => {
    const model = await createDomainModel({ name: "test-647-list-dm" });
    createdModelIds.push(model.id);

    const entry = await createTestEntry("list-dm");
    await tagCleanedDataWithDomain(entry.id, model.id);

    const entries = await listCuratedEntries({ domainModelId: model.id });
    expect(entries.some(e => e.id === entry.id)).toBe(true);
  });

  test("filters by memory tier", async () => {
    const model = await createDomainModel({ name: "test-647-list-tier" });
    createdModelIds.push(model.id);

    const entry = await createTestEntry("list-tier");
    await tagCleanedDataWithDomain(entry.id, model.id);
    await setMemoryTier(entry.id, "core");

    const coreEntries = await listCuratedEntries({
      domainModelId: model.id,
      memoryTier: "core",
    });
    expect(coreEntries.some(e => e.id === entry.id)).toBe(true);
  });

  test("supports search", async () => {
    const entry = await createTestEntry("list-search-unique-xyzzy");
    const results = await listCuratedEntries({ search: "xyzzy" });
    expect(results.some(e => e.id === entry.id)).toBe(true);
  });

  test("supports pagination", async () => {
    const entries = await listCuratedEntries({ limit: 2, offset: 0 });
    expect(entries.length).toBeLessThanOrEqual(2);
  });
});

describe("getCuratedEntry", () => {
  test("returns entry by ID with curation fields", async () => {
    const entry = await createTestEntry("get-curated");
    await approveEntry(entry.id, "Verified");
    await setMemoryTier(entry.id, "core");

    const fetched = await getCuratedEntry(entry.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.curation_status).toBe("approved");
    expect(fetched!.memory_tier).toBe("core");
    expect(fetched!.curator_notes).toBe("Verified");
  });

  test("returns null for unknown ID", async () => {
    const result = await getCuratedEntry("00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });
});

// ── Stats ───────────────────────────────────────────────

describe("getCurationStats", () => {
  test("returns global stats", async () => {
    const stats = await getCurationStats();
    expect(typeof stats.totalEntries).toBe("number");
    expect(typeof stats.pendingReview).toBe("number");
    expect(typeof stats.approved).toBe("number");
    expect(typeof stats.rejected).toBe("number");
    expect(typeof stats.needsEditing).toBe("number");
    expect(typeof stats.tierBreakdown.untiered).toBe("number");
    expect(typeof stats.tierBreakdown.core).toBe("number");
    expect(typeof stats.tierBreakdown.extended).toBe("number");
  });

  test("returns stats for specific domain model", async () => {
    const model = await createDomainModel({ name: "test-647-stats" });
    createdModelIds.push(model.id);

    const e1 = await createTestEntry("stats-1");
    const e2 = await createTestEntry("stats-2");
    await tagCleanedDataWithDomain(e1.id, model.id);
    await tagCleanedDataWithDomain(e2.id, model.id);
    await approveEntry(e1.id);
    await setMemoryTier(e1.id, "core");

    const stats = await getCurationStats(model.id);
    expect(stats.totalEntries).toBe(2);
    expect(stats.approved).toBe(1);
    expect(stats.pendingReview).toBe(1);
    expect(stats.tierBreakdown.core).toBe(1);
  });

  test("returns zeros for empty domain model", async () => {
    const model = await createDomainModel({ name: "test-647-stats-empty" });
    createdModelIds.push(model.id);

    const stats = await getCurationStats(model.id);
    expect(stats.totalEntries).toBe(0);
    expect(stats.approved).toBe(0);
    expect(stats.pendingReview).toBe(0);
  });
});

// ── Workflow Integration ────────────────────────────────

describe("curation workflow", () => {
  test("full lifecycle: ingest → review → edit → approve → promote", async () => {
    const model = await createDomainModel({ name: "test-647-lifecycle" });
    createdModelIds.push(model.id);

    // Ingest
    const entry = await createTestEntry("lifecycle");
    await tagCleanedDataWithDomain(entry.id, model.id);

    // Check initial state
    let current = await getCuratedEntry(entry.id);
    expect(current!.curation_status).toBe("pending_review");
    expect(current!.memory_tier).toBe("untiered");

    // Mark needs editing
    await markNeedsEditing(entry.id, "Fix formatting");
    current = await getCuratedEntry(entry.id);
    expect(current!.curation_status).toBe("needs_editing");

    // Edit
    await editEntry(entry.id, { content: "Improved content" });
    current = await getCuratedEntry(entry.id);
    expect(current!.content).toBe("Improved content");

    // Approve
    await approveEntry(entry.id, "Content fixed and verified");
    current = await getCuratedEntry(entry.id);
    expect(current!.curation_status).toBe("approved");

    // Promote to core
    await promoteToCoreTier(entry.id);
    current = await getCuratedEntry(entry.id);
    expect(current!.memory_tier).toBe("core");

    // Stats reflect it
    const stats = await getCurationStats(model.id);
    expect(stats.approved).toBe(1);
    expect(stats.tierBreakdown.core).toBe(1);
  });
});
