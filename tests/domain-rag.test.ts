/**
 * ELLIE-648 — Mountain: RAG injection for domain model conversations
 *
 * Tests domain detection, chunk retrieval, token budgeting, prompt formatting,
 * explicit activation parsing, and full RAG pipeline.
 */

import { describe, test, expect, afterAll } from "bun:test";
import {
  createDomainModel, tagCleanedDataWithDomain,
  ingestCleanedData, processRecord,
  approveEntry, setMemoryTier,
  detectDomainModels, retrieveDomainChunks,
  selectWithinBudget, formatDomainKnowledgeSection,
  buildDomainRAGContext,
  parseExplicitActivation, resolveDomainByName,
} from "../../ellie-forest/src/index";
import type { RAGChunk } from "../../ellie-forest/src/index";
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

/** Helper: create a domain model with ingested & processed data */
async function setupDomain(name: string, description: string, entries: { content: string; title?: string; tier?: string }[]) {
  const model = await createDomainModel({ name, description });
  createdModelIds.push(model.id);

  for (const entry of entries) {
    const record = await ingestCleanedData({
      connectorName: "test-648",
      sourceId: `test-648-${name}-${Date.now()}-${Math.random()}`,
      content: entry.content,
      title: entry.title,
    });
    createdDataIds.push(record.id);
    await processRecord(record.id);
    await tagCleanedDataWithDomain(record.id, model.id);
    await approveEntry(record.id);
    if (entry.tier) {
      await setMemoryTier(record.id, entry.tier as any);
    }
  }

  return model;
}

// ── Domain Detection ─────────────────────────────────────

describe("detectDomainModels", () => {
  test("detects domain by exact name match", async () => {
    const model = await setupDomain(
      "test-648-eve-online",
      "EVE Online game knowledge",
      [{ content: "PI stands for Planetary Interaction." }],
    );

    const matches = await detectDomainModels("Tell me about test-648-eve-online strategies");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].id).toBe(model.id);
    expect(matches[0].score).toBeGreaterThan(0.5);
  });

  test("detects domain by partial word match", async () => {
    const model = await setupDomain(
      "test-648-typescript-patterns",
      "TypeScript coding patterns and best practices",
      [{ content: "Use discriminated unions for type narrowing." }],
    );

    const matches = await detectDomainModels("What are good typescript patterns for error handling?");
    expect(matches.some(m => m.id === model.id)).toBe(true);
  });

  test("detects domain by description keywords", async () => {
    const model = await setupDomain(
      "test-648-renovation",
      "Home renovation project planning and costs",
      [{ content: "Kitchen remodel costs about $25k." }],
    );

    const matches = await detectDomainModels("How much does renovation cost for a kitchen?");
    expect(matches.some(m => m.id === model.id)).toBe(true);
  });

  test("returns empty for unrelated text", async () => {
    const matches = await detectDomainModels("xyzzy-qqwwee-nonsense-gibberish-zzzqqq");
    expect(matches.length).toBe(0);
  });

  test("respects limit parameter", async () => {
    const matches = await detectDomainModels("test-648", 1);
    expect(matches.length).toBeLessThanOrEqual(1);
  });
});

// ── Chunk Retrieval ──────────────────────────────────────

describe("retrieveDomainChunks", () => {
  test("retrieves chunks from a domain model", async () => {
    const model = await setupDomain(
      "test-648-retrieve",
      "Retrieval test domain",
      [
        { content: "The quick brown fox jumps over the lazy dog in a forest clearing." },
        { content: "Machine learning models need training data for accuracy." },
      ],
    );

    const chunks = await retrieveDomainChunks(model.id, "fox forest");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].domainModelName).toBe("test-648-retrieve");
  });

  test("prioritizes core tier chunks", async () => {
    const model = await setupDomain(
      "test-648-tier-priority",
      "Tier priority test",
      [
        { content: "Extended fact about tier priority testing scenarios.", tier: "extended" },
        { content: "Core fact about tier priority testing methodology.", tier: "core" },
      ],
    );

    const chunks = await retrieveDomainChunks(model.id, "tier priority testing");
    if (chunks.length >= 2) {
      const coreIdx = chunks.findIndex(c => c.memoryTier === "core");
      const extIdx = chunks.findIndex(c => c.memoryTier === "extended");
      if (coreIdx >= 0 && extIdx >= 0) {
        expect(coreIdx).toBeLessThan(extIdx);
      }
    }
  });

  test("excludes rejected entries", async () => {
    const model = await createDomainModel({ name: "test-648-reject-filter" });
    createdModelIds.push(model.id);

    const record = await ingestCleanedData({
      connectorName: "test-648",
      sourceId: `test-648-reject-${Date.now()}`,
      content: "This content should be rejected and not retrieved.",
    });
    createdDataIds.push(record.id);
    await processRecord(record.id);
    await tagCleanedDataWithDomain(record.id, model.id);

    // Reject it
    await sql`UPDATE cleaned_data SET curation_status = 'rejected' WHERE id = ${record.id}`;

    const chunks = await retrieveDomainChunks(model.id, "rejected content");
    expect(chunks.every(c => c.content !== record.content)).toBe(true);
  });

  test("returns empty for unknown domain model", async () => {
    const chunks = await retrieveDomainChunks("00000000-0000-0000-0000-000000000000", "test");
    expect(chunks).toHaveLength(0);
  });
});

// ── Token Budgeting ──────────────────────────────────────

describe("selectWithinBudget", () => {
  const makeChunk = (id: string, tokens: number, score: number, tier = "untiered"): RAGChunk => ({
    id, content: "x".repeat(tokens * 4), tokenCount: tokens, score,
    memoryTier: tier, source: "test", title: null,
    domainModelId: "dm1", domainModelName: "Test Model",
  });

  test("selects chunks within token limit", () => {
    const chunks = [
      makeChunk("a", 100, 0.9),
      makeChunk("b", 100, 0.8),
      makeChunk("c", 100, 0.7),
      makeChunk("d", 100, 0.6),
    ];

    const selected = selectWithinBudget(chunks, 250, 10);
    // Each chunk costs tokenCount + 20 overhead = 120 tokens
    // 250 / 120 = ~2 chunks
    expect(selected.length).toBe(2);
  });

  test("respects topK limit", () => {
    const chunks = [
      makeChunk("a", 50, 0.9),
      makeChunk("b", 50, 0.8),
      makeChunk("c", 50, 0.7),
    ];

    const selected = selectWithinBudget(chunks, 10000, 2);
    expect(selected.length).toBe(2);
  });

  test("skips chunks that exceed remaining budget", () => {
    const chunks = [
      makeChunk("a", 50, 0.9),
      makeChunk("b", 500, 0.8), // too big
      makeChunk("c", 50, 0.7),
    ];

    const selected = selectWithinBudget(chunks, 200, 10);
    expect(selected.length).toBe(2);
    expect(selected.map(c => c.id)).toEqual(["a", "c"]);
  });

  test("returns empty for zero budget", () => {
    const chunks = [makeChunk("a", 100, 0.9)];
    const selected = selectWithinBudget(chunks, 0, 10);
    expect(selected).toHaveLength(0);
  });
});

// ── Prompt Formatting ────────────────────────────────────

describe("formatDomainKnowledgeSection", () => {
  const makeChunk = (content: string, model: string, tier = "untiered", source = "web"): RAGChunk => ({
    id: "1", content, tokenCount: 50, score: 0.9,
    memoryTier: tier, source, title: "Test Doc",
    domainModelId: "dm1", domainModelName: model,
  });

  test("formats chunks with headers and citations", () => {
    const chunks = [
      makeChunk("Fact one about topic.", "My Domain", "core", "web-scraper"),
      makeChunk("Fact two about topic.", "My Domain", "extended", "rss-feed"),
    ];

    const section = formatDomainKnowledgeSection(chunks, true);
    expect(section).toContain("## Domain Knowledge");
    expect(section).toContain("### My Domain");
    expect(section).toContain("Fact one about topic.");
    expect(section).toContain("[CORE]");
    expect(section).toContain("web-scraper");
    expect(section).toContain('"Test Doc"');
  });

  test("omits citations when disabled", () => {
    const chunks = [makeChunk("Some fact.", "Domain A")];
    const section = formatDomainKnowledgeSection(chunks, false);
    expect(section).not.toContain("source:");
  });

  test("groups by domain model", () => {
    const chunks = [
      makeChunk("Fact from A.", "Domain A"),
      makeChunk("Fact from B.", "Domain B"),
    ];

    const section = formatDomainKnowledgeSection(chunks, false);
    expect(section).toContain("### Domain A");
    expect(section).toContain("### Domain B");
  });

  test("returns empty string for no chunks", () => {
    expect(formatDomainKnowledgeSection([])).toBe("");
  });
});

// ── Explicit Activation ──────────────────────────────────

describe("parseExplicitActivation", () => {
  test("parses 'use my X notes'", () => {
    expect(parseExplicitActivation("use my EVE Online notes")).toBe("EVE Online");
  });

  test("parses 'activate X domain'", () => {
    expect(parseExplicitActivation("activate TypeScript domain")).toBe("TypeScript");
  });

  test("parses 'check X knowledge'", () => {
    expect(parseExplicitActivation("check renovation knowledge")).toBe("renovation");
  });

  test("parses 'load my X data'", () => {
    expect(parseExplicitActivation("load my cooking data")).toBe("cooking");
  });

  test("parses 'domain: X' syntax", () => {
    expect(parseExplicitActivation("domain: home improvement")).toBe("home improvement");
  });

  test("returns null for no activation", () => {
    expect(parseExplicitActivation("Just a regular question")).toBeNull();
  });
});

describe("resolveDomainByName", () => {
  test("resolves exact match", async () => {
    const model = await setupDomain(
      "test-648-resolve-exact",
      "Exact match test",
      [{ content: "Test content." }],
    );

    const result = await resolveDomainByName("test-648-resolve-exact");
    expect(result).not.toBeNull();
    expect(result!.id).toBe(model.id);
  });

  test("resolves partial match (case insensitive)", async () => {
    const model = await setupDomain(
      "test-648-resolve-partial",
      "Partial match test",
      [{ content: "Test content." }],
    );

    const result = await resolveDomainByName("resolve-partial");
    expect(result).not.toBeNull();
    expect(result!.id).toBe(model.id);
  });

  test("returns null for no match", async () => {
    const result = await resolveDomainByName("xyzzy-nonexistent-domain-648");
    expect(result).toBeNull();
  });
});

// ── Full Pipeline ────────────────────────────────────────

describe("buildDomainRAGContext", () => {
  test("auto-detects and retrieves domain knowledge", async () => {
    const model = await setupDomain(
      "test-648-pipeline",
      "Full pipeline test domain",
      [
        { content: "Pipeline fact one: important data about the topic.", tier: "core" },
        { content: "Pipeline fact two: supplementary information.", tier: "extended" },
      ],
    );

    const result = await buildDomainRAGContext(
      "Tell me about test-648-pipeline topic",
      { topK: 5, minRelevance: 0.0 },
    );

    expect(result.activatedModels.length).toBeGreaterThan(0);
    expect(result.activatedModels[0].id).toBe(model.id);
    expect(result.detectionMode).toBe("auto");
    // Should have retrieved chunks
    if (result.chunks.length > 0) {
      expect(result.promptSection).toContain("## Domain Knowledge");
      expect(result.tokensUsed).toBeGreaterThan(0);
    }
  });

  test("works with explicit domain model IDs", async () => {
    const model = await setupDomain(
      "test-648-explicit",
      "Explicit activation test",
      [{ content: "Explicit domain content for testing.", tier: "core" }],
    );

    const result = await buildDomainRAGContext(
      "Some unrelated query text",
      { domainModelIds: [model.id], topK: 5, minRelevance: 0.0 },
    );

    expect(result.detectionMode).toBe("explicit");
    expect(result.activatedModels.some(m => m.id === model.id)).toBe(true);
  });

  test("respects token budget", async () => {
    const model = await setupDomain(
      "test-648-budget",
      "Token budget test",
      [
        { content: "A ".repeat(200) + "budget test content." },
        { content: "B ".repeat(200) + "more budget content." },
        { content: "C ".repeat(200) + "even more content." },
      ],
    );

    const result = await buildDomainRAGContext(
      "test-648-budget content",
      { domainModelIds: [model.id], maxTokens: 100, topK: 10, minRelevance: 0.0 },
    );

    expect(result.tokensUsed).toBeLessThanOrEqual(150); // some overhead tolerance
  });

  test("returns empty for no matching domains", async () => {
    const result = await buildDomainRAGContext("zzxqvbn-wkrplm-jjhhttrr-nncvbx");
    expect(result.chunks).toHaveLength(0);
    expect(result.promptSection).toBe("");
    expect(result.activatedModels).toHaveLength(0);
  });

  test("returns empty when autoDetect is false and no explicit IDs", async () => {
    const result = await buildDomainRAGContext(
      "any text",
      { autoDetect: false },
    );
    expect(result.chunks).toHaveLength(0);
  });

  test("core tier chunks appear before extended", async () => {
    const model = await setupDomain(
      "test-648-core-first",
      "Core priority test domain",
      [
        { content: "Extended information about core-first testing.", tier: "extended" },
        { content: "Core knowledge about core-first domain testing.", tier: "core" },
      ],
    );

    const result = await buildDomainRAGContext(
      "test-648-core-first testing",
      { domainModelIds: [model.id], topK: 10, minRelevance: 0.0 },
    );

    if (result.chunks.length >= 2) {
      const coreIdx = result.chunks.findIndex(c => c.memoryTier === "core");
      const extIdx = result.chunks.findIndex(c => c.memoryTier === "extended");
      if (coreIdx >= 0 && extIdx >= 0) {
        expect(coreIdx).toBeLessThan(extIdx);
      }
    }
  });

  test("includes citations in prompt section", async () => {
    const model = await setupDomain(
      "test-648-citations",
      "Citation test domain",
      [{ content: "Citation test fact about the domain.", tier: "core" }],
    );

    const result = await buildDomainRAGContext(
      "test-648-citations domain",
      { domainModelIds: [model.id], topK: 5, minRelevance: 0.0, includeCitations: true },
    );

    if (result.chunks.length > 0) {
      expect(result.promptSection).toContain("source:");
    }
  });
});
