/**
 * ELLIE-646 — Mountain: Domain model definition & River collection mapping
 *
 * Tests CRUD, source management, data flow tagging, stats, and config.
 */

import { describe, test, expect, afterAll } from "bun:test";
import {
  createDomainModel, getDomainModel, getDomainModelByName,
  getDomainModelByCollection, listDomainModels,
  updateDomainModel, archiveDomainModel, deleteDomainModel,
  addDomainSource, removeDomainSource, toggleDomainSource,
  listDomainSources, listModelsForConnector,
  tagCleanedDataWithDomain, getDomainCleanedData, getDomainStats,
  ingestCleanedData,
} from "../../ellie-forest/src/index";
import sql from "../../ellie-forest/src/db";

const createdModelIds: string[] = [];
const createdDataIds: string[] = [];

afterAll(async () => {
  // Unlink cleaned_data first, then delete models (FK constraint)
  if (createdDataIds.length > 0) {
    await sql`UPDATE cleaned_data SET domain_model_id = NULL WHERE id = ANY(${createdDataIds})`;
    await sql`DELETE FROM cleaned_data WHERE id = ANY(${createdDataIds})`;
  }
  if (createdModelIds.length > 0) {
    await sql`DELETE FROM domain_model_sources WHERE domain_model_id = ANY(${createdModelIds})`;
    await sql`DELETE FROM domain_models WHERE id = ANY(${createdModelIds})`;
  }
});

// ── CRUD ──────────────────────────────────────────────────────

describe("createDomainModel", () => {
  test("creates with auto-generated collection name", async () => {
    const model = await createDomainModel({
      name: "test-646-basic",
      description: "Basic test domain",
    });
    createdModelIds.push(model.id);

    expect(model.name).toBe("test-646-basic");
    expect(model.description).toBe("Basic test domain");
    expect(model.river_collection).toBe("dm-test-646-basic");
    expect(model.status).toBe("active");
  });

  test("creates with custom collection name", async () => {
    const model = await createDomainModel({
      name: "test-646-custom-coll",
      riverCollection: "my-custom-collection",
    });
    createdModelIds.push(model.id);
    expect(model.river_collection).toBe("my-custom-collection");
  });

  test("applies default config values", async () => {
    const model = await createDomainModel({ name: "test-646-defaults" });
    createdModelIds.push(model.id);

    expect(model.config.memoryTierSplit).toBe(true);
    expect(model.config.autoPromoteThreshold).toBe(5);
    expect(model.config.coreMemoryCap).toBe(50);
    expect(model.config.goalFactLinking).toBe(false);
  });

  test("merges custom config with defaults", async () => {
    const model = await createDomainModel({
      name: "test-646-config",
      config: { coreMemoryCap: 100, goalFactLinking: true },
    });
    createdModelIds.push(model.id);

    expect(model.config.coreMemoryCap).toBe(100);
    expect(model.config.goalFactLinking).toBe(true);
    expect(model.config.memoryTierSplit).toBe(true); // default preserved
  });

  test("rejects duplicate names", async () => {
    const model = await createDomainModel({ name: "test-646-unique" });
    createdModelIds.push(model.id);
    expect(createDomainModel({ name: "test-646-unique" })).rejects.toThrow();
  });
});

describe("getDomainModel", () => {
  test("returns model by ID", async () => {
    const model = await createDomainModel({ name: "test-646-getid" });
    createdModelIds.push(model.id);

    const fetched = await getDomainModel(model.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe("test-646-getid");
  });

  test("returns null for unknown ID", async () => {
    const result = await getDomainModel("00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });
});

describe("getDomainModelByName", () => {
  test("finds by name", async () => {
    const model = await createDomainModel({ name: "test-646-byname" });
    createdModelIds.push(model.id);

    const fetched = await getDomainModelByName("test-646-byname");
    expect(fetched!.id).toBe(model.id);
  });
});

describe("getDomainModelByCollection", () => {
  test("finds by collection name", async () => {
    const model = await createDomainModel({
      name: "test-646-bycoll",
      riverCollection: "test-646-river-coll",
    });
    createdModelIds.push(model.id);

    const fetched = await getDomainModelByCollection("test-646-river-coll");
    expect(fetched!.id).toBe(model.id);
  });
});

describe("listDomainModels", () => {
  test("lists all models", async () => {
    const models = await listDomainModels();
    expect(Array.isArray(models)).toBe(true);
  });

  test("filters by status", async () => {
    const model = await createDomainModel({ name: "test-646-list-active" });
    createdModelIds.push(model.id);

    const active = await listDomainModels("active");
    expect(active.some(m => m.id === model.id)).toBe(true);

    await archiveDomainModel(model.id);
    const activeAfter = await listDomainModels("active");
    expect(activeAfter.some(m => m.id === model.id)).toBe(false);

    const archived = await listDomainModels("archived");
    expect(archived.some(m => m.id === model.id)).toBe(true);
  });
});

describe("updateDomainModel", () => {
  test("updates name and description", async () => {
    const model = await createDomainModel({ name: "test-646-update" });
    createdModelIds.push(model.id);

    const updated = await updateDomainModel(model.id, {
      name: "test-646-updated",
      description: "New description",
    });
    expect(updated!.name).toBe("test-646-updated");
    expect(updated!.description).toBe("New description");
  });

  test("merges config updates", async () => {
    const model = await createDomainModel({
      name: "test-646-config-update",
      config: { coreMemoryCap: 50, goalFactLinking: false },
    });
    createdModelIds.push(model.id);

    const updated = await updateDomainModel(model.id, {
      config: { coreMemoryCap: 75 },
    });
    expect(updated!.config.coreMemoryCap).toBe(75);
    expect(updated!.config.goalFactLinking).toBe(false); // preserved
  });

  test("returns null for unknown ID", async () => {
    const result = await updateDomainModel("00000000-0000-0000-0000-000000000000", { name: "x" });
    expect(result).toBeNull();
  });
});

describe("archiveDomainModel", () => {
  test("sets status to archived", async () => {
    const model = await createDomainModel({ name: "test-646-archive" });
    createdModelIds.push(model.id);

    const archived = await archiveDomainModel(model.id);
    expect(archived!.status).toBe("archived");
  });
});

describe("deleteDomainModel", () => {
  test("hard deletes model and cascades sources", async () => {
    const model = await createDomainModel({ name: "test-646-delete" });
    await addDomainSource(model.id, "test-connector");

    const deleted = await deleteDomainModel(model.id);
    expect(deleted).toBe(true);

    const fetched = await getDomainModel(model.id);
    expect(fetched).toBeNull();
  });

  test("returns false for unknown ID", async () => {
    const deleted = await deleteDomainModel("00000000-0000-0000-0000-000000000000");
    expect(deleted).toBe(false);
  });

  test("unlinks cleaned_data on delete", async () => {
    const model = await createDomainModel({ name: "test-646-delete-unlink" });
    const data = await ingestCleanedData({
      connectorName: "test-646",
      sourceId: "test-646-unlink",
      content: "Content for unlink test.",
    });
    createdDataIds.push(data.id);
    await tagCleanedDataWithDomain(data.id, model.id);

    await deleteDomainModel(model.id);
    const [row] = await sql<{ domain_model_id: string | null }[]>`
      SELECT domain_model_id FROM cleaned_data WHERE id = ${data.id}
    `;
    expect(row.domain_model_id).toBeNull();
  });
});

// ── Sources ───────────────────────────────────────────────────

describe("domain model sources", () => {
  test("addDomainSource creates a source link", async () => {
    const model = await createDomainModel({ name: "test-646-src-add" });
    createdModelIds.push(model.id);

    const source = await addDomainSource(model.id, "web-scraper", { url: "https://example.com" });
    expect(source.connector_name).toBe("web-scraper");
    expect(source.enabled).toBe(true);
    expect(source.source_config).toEqual({ url: "https://example.com" });
  });

  test("addDomainSource upserts on conflict", async () => {
    const model = await createDomainModel({ name: "test-646-src-upsert" });
    createdModelIds.push(model.id);

    await addDomainSource(model.id, "rss-feed", { url: "old" });
    const updated = await addDomainSource(model.id, "rss-feed", { url: "new" });
    expect(updated.source_config).toEqual({ url: "new" });

    const sources = await listDomainSources(model.id);
    expect(sources).toHaveLength(1);
  });

  test("removeDomainSource deletes link", async () => {
    const model = await createDomainModel({ name: "test-646-src-remove" });
    createdModelIds.push(model.id);

    await addDomainSource(model.id, "api-poller");
    const removed = await removeDomainSource(model.id, "api-poller");
    expect(removed).toBe(true);

    const sources = await listDomainSources(model.id);
    expect(sources).toHaveLength(0);
  });

  test("toggleDomainSource enables/disables", async () => {
    const model = await createDomainModel({ name: "test-646-src-toggle" });
    createdModelIds.push(model.id);

    await addDomainSource(model.id, "manual-paste");
    const disabled = await toggleDomainSource(model.id, "manual-paste", false);
    expect(disabled!.enabled).toBe(false);

    const enabled = await toggleDomainSource(model.id, "manual-paste", true);
    expect(enabled!.enabled).toBe(true);
  });

  test("listDomainSources returns all sources", async () => {
    const model = await createDomainModel({ name: "test-646-src-list" });
    createdModelIds.push(model.id);

    await addDomainSource(model.id, "web-scraper");
    await addDomainSource(model.id, "rss-feed");
    await addDomainSource(model.id, "manual-paste");

    const sources = await listDomainSources(model.id);
    expect(sources).toHaveLength(3);
  });

  test("listModelsForConnector finds active models", async () => {
    const model = await createDomainModel({ name: "test-646-connector-lookup" });
    createdModelIds.push(model.id);
    await addDomainSource(model.id, "test-646-special-connector");

    const models = await listModelsForConnector("test-646-special-connector");
    expect(models.some(m => m.id === model.id)).toBe(true);
  });

  test("listModelsForConnector excludes disabled sources", async () => {
    const model = await createDomainModel({ name: "test-646-connector-disabled" });
    createdModelIds.push(model.id);
    await addDomainSource(model.id, "test-646-disabled-conn");
    await toggleDomainSource(model.id, "test-646-disabled-conn", false);

    const models = await listModelsForConnector("test-646-disabled-conn");
    expect(models.some(m => m.id === model.id)).toBe(false);
  });
});

// ── Data Flow ─────────────────────────────────────────────────

describe("data flow", () => {
  test("tagCleanedDataWithDomain links data to model", async () => {
    const model = await createDomainModel({ name: "test-646-tag" });
    createdModelIds.push(model.id);

    const data = await ingestCleanedData({
      connectorName: "test-646",
      sourceId: "test-646-tag-data",
      content: "Content for tagging test.",
    });
    createdDataIds.push(data.id);

    await tagCleanedDataWithDomain(data.id, model.id);

    const [row] = await sql<{ domain_model_id: string }[]>`
      SELECT domain_model_id FROM cleaned_data WHERE id = ${data.id}
    `;
    expect(row.domain_model_id).toBe(model.id);
  });

  test("getDomainCleanedData returns tagged records", async () => {
    const model = await createDomainModel({ name: "test-646-domain-data" });
    createdModelIds.push(model.id);

    const d1 = await ingestCleanedData({
      connectorName: "test-646",
      sourceId: "test-646-dd-1",
      content: "First domain record.",
    });
    createdDataIds.push(d1.id);
    const d2 = await ingestCleanedData({
      connectorName: "test-646",
      sourceId: "test-646-dd-2",
      content: "Second domain record.",
    });
    createdDataIds.push(d2.id);

    await tagCleanedDataWithDomain(d1.id, model.id);
    await tagCleanedDataWithDomain(d2.id, model.id);

    const data = await getDomainCleanedData(model.id);
    expect(data.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Stats ─────────────────────────────────────────────────────

describe("getDomainStats", () => {
  test("returns source and data counts", async () => {
    const model = await createDomainModel({ name: "test-646-stats" });
    createdModelIds.push(model.id);

    await addDomainSource(model.id, "web-scraper");
    await addDomainSource(model.id, "rss-feed");
    await toggleDomainSource(model.id, "rss-feed", false);

    const data = await ingestCleanedData({
      connectorName: "test-646",
      sourceId: "test-646-stats-data",
      content: "Stats test content.",
    });
    createdDataIds.push(data.id);
    await tagCleanedDataWithDomain(data.id, model.id);

    const stats = await getDomainStats(model.id);
    expect(stats).not.toBeNull();
    expect(stats!.sourceCount).toBe(2);
    expect(stats!.enabledSourceCount).toBe(1);
    expect(stats!.dataCount).toBe(1);
    expect(stats!.config.memoryTierSplit).toBe(true);
  });

  test("returns null for unknown model", async () => {
    const stats = await getDomainStats("00000000-0000-0000-0000-000000000000");
    expect(stats).toBeNull();
  });
});
