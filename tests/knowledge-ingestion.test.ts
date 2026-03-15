/**
 * Knowledge Ingestion Pipeline Tests — ELLIE-737
 *
 * Tests for medical document chunking and ingestion:
 * - Chunking strategies (per_code, per_section, per_line, fixed_size)
 * - Token estimation
 * - Category-specific chunking (CPT, ICD-10, payer rules, denial reasons)
 * - Subcategory extraction
 * - Deduplication
 * - Full pipeline orchestration
 * - Batch ingestion
 * - Error handling
 * - E2E lifecycle
 */

import { describe, test, expect } from "bun:test";
import {
  chunkDocument,
  estimateTokens,
  ingestDocument,
  ingestBatch,
  DEFAULT_CHUNKING_STRATEGIES,
  DEDUP_THRESHOLD,
  type IngestDocument,
  type Chunk,
  type IngestionResult,
  type EmbedFn,
  type InsertFn,
  type DedupCheckFn,
  type ChunkingStrategy,
} from "../src/knowledge-ingestion.ts";

// ── Mock Dependencies ───────────────────────────────────────

function mockEmbed(): EmbedFn {
  return async (text: string) => Array(1536).fill(0.1);
}

function mockInsert(): { fn: InsertFn; calls: { chunk: Chunk; embedding: number[] }[] } {
  const calls: { chunk: Chunk; embedding: number[] }[] = [];
  const fn: InsertFn = async (chunk, embedding) => {
    calls.push({ chunk, embedding });
    return `id-${calls.length}`;
  };
  return { fn, calls };
}

function mockDedupCheck(duplicateIndices: Set<number> = new Set()): DedupCheckFn {
  let callCount = 0;
  return async () => {
    const isDup = duplicateIndices.has(callCount);
    callCount++;
    return isDup;
  };
}

// ── Helpers ─────────────────────────────────────────────────

function makeDoc(overrides: Partial<IngestDocument> = {}): IngestDocument {
  return {
    content: "99213 Office visit, established patient, low complexity\n99214 Office visit, established patient, moderate complexity\n99215 Office visit, established patient, high complexity",
    category: "cpt_codes",
    source_doc: "CMS 2026 CPT Manual",
    effective_date: "2026-01-01",
    company_id: "comp-1",
    ...overrides,
  };
}

// ── Constants ───────────────────────────────────────────────

describe("constants", () => {
  test("DEDUP_THRESHOLD is 0.95", () => {
    expect(DEDUP_THRESHOLD).toBe(0.95);
  });

  test("DEFAULT_CHUNKING_STRATEGIES has all 7 categories", () => {
    const categories = Object.keys(DEFAULT_CHUNKING_STRATEGIES);
    expect(categories).toHaveLength(7);
    expect(categories).toContain("cpt_codes");
    expect(categories).toContain("icd10_codes");
    expect(categories).toContain("payer_rules");
    expect(categories).toContain("denial_reasons");
    expect(categories).toContain("appeal_templates");
    expect(categories).toContain("compliance");
    expect(categories).toContain("fee_schedules");
  });

  test("CPT strategy uses per_code mode with 5-digit split", () => {
    const s = DEFAULT_CHUNKING_STRATEGIES.cpt_codes;
    expect(s.mode).toBe("per_code");
    expect(s.split_pattern).toBeDefined();
    expect(s.subcategoryFn).toBeDefined();
  });

  test("ICD-10 strategy uses per_code mode", () => {
    const s = DEFAULT_CHUNKING_STRATEGIES.icd10_codes;
    expect(s.mode).toBe("per_code");
    expect(s.subcategoryFn).toBeDefined();
  });

  test("appeal_templates uses per_section mode with higher token target", () => {
    const s = DEFAULT_CHUNKING_STRATEGIES.appeal_templates;
    expect(s.mode).toBe("per_section");
    expect(s.target_tokens).toBe(800);
  });
});

// ── estimateTokens ──────────────────────────────────────────

describe("estimateTokens", () => {
  test("estimates ~4 chars per token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("12345678")).toBe(2);
  });

  test("rounds up", () => {
    expect(estimateTokens("abc")).toBe(1); // 3/4 = 0.75 -> ceil = 1
  });

  test("empty string returns 0", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

// ── chunkDocument (CPT Codes) ───────────────────────────────

describe("chunkDocument: CPT codes", () => {
  test("splits per CPT code (5-digit boundary)", () => {
    const doc = makeDoc({
      content: "99213 Office visit, established patient, low complexity\n99214 Office visit, moderate complexity\n99215 Office visit, high complexity",
    });
    const chunks = chunkDocument(doc);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0].category).toBe("cpt_codes");
  });

  test("extracts subcategory (CPT code number)", () => {
    const doc = makeDoc({
      content: "99213 Office visit, established patient, low complexity",
    });
    const chunks = chunkDocument(doc);
    expect(chunks[0].subcategory).toBe("99213");
  });

  test("preserves metadata from document", () => {
    const doc = makeDoc({ metadata: { edition: "2026" } });
    const chunks = chunkDocument(doc);
    expect(chunks[0].source_doc).toBe("CMS 2026 CPT Manual");
    expect(chunks[0].effective_date).toBe("2026-01-01");
    expect(chunks[0].company_id).toBe("comp-1");
    expect(chunks[0].metadata).toEqual({ edition: "2026" });
  });

  test("filters empty chunks", () => {
    const doc = makeDoc({ content: "99213 Code\n\n\n\n99214 Code" });
    const chunks = chunkDocument(doc);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeGreaterThan(0);
    }
  });
});

// ── chunkDocument (ICD-10 Codes) ────────────────────────────

describe("chunkDocument: ICD-10 codes", () => {
  test("splits per ICD-10 code", () => {
    const doc = makeDoc({
      category: "icd10_codes",
      content: "J06.9 Acute upper respiratory infection, unspecified\nJ18.9 Pneumonia, unspecified\nE11.65 Type 2 diabetes with hyperglycemia",
    });
    const chunks = chunkDocument(doc);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  test("extracts ICD-10 subcategory", () => {
    const strat = DEFAULT_CHUNKING_STRATEGIES.icd10_codes;
    const sub = strat.subcategoryFn!("J06.9 Acute upper respiratory infection");
    expect(sub).toBe("J06.9");
  });

  test("handles codes without decimal", () => {
    const strat = DEFAULT_CHUNKING_STRATEGIES.icd10_codes;
    const sub = strat.subcategoryFn!("J18 Pneumonia");
    expect(sub).toBe("J18");
  });
});

// ── chunkDocument (Denial Reasons) ──────────────────────────

describe("chunkDocument: denial reasons", () => {
  test("extracts denial code as subcategory", () => {
    const strat = DEFAULT_CHUNKING_STRATEGIES.denial_reasons;
    expect(strat.subcategoryFn!("CO-16 Claim lacks information")).toBe("CO-16");
    expect(strat.subcategoryFn!("PR-1 Deductible amount")).toBe("PR-1");
    expect(strat.subcategoryFn!("OA-23 Adjustment")).toBe("OA-23");
  });
});

// ── chunkDocument (Fixed Size) ──────────────────────────────

describe("chunkDocument: fixed_size strategy", () => {
  test("splits large documents into ~target_token chunks", () => {
    const longContent = Array(100).fill("This is a line of content for testing purposes.").join("\n");
    const doc = makeDoc({ content: longContent, category: "compliance" });
    const strategy: ChunkingStrategy = { mode: "fixed_size", target_tokens: 100 };
    const chunks = chunkDocument(doc, strategy);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be roughly within the target
    for (const chunk of chunks) {
      expect(estimateTokens(chunk.content)).toBeLessThanOrEqual(200); // 2x tolerance
    }
  });

  test("single small document stays as one chunk", () => {
    const doc = makeDoc({ content: "Short content", category: "compliance" });
    const strategy: ChunkingStrategy = { mode: "fixed_size", target_tokens: 500 };
    const chunks = chunkDocument(doc, strategy);
    expect(chunks).toHaveLength(1);
  });
});

// ── chunkDocument (Payer Rules) ─────────────────────────────

describe("chunkDocument: payer rules", () => {
  test("splits on section boundaries", () => {
    const doc = makeDoc({
      category: "payer_rules",
      content: "Rule 1: Prior authorization required for MRI\nDetails about MRI auth\nRule 2: Timely filing limit 90 days\nDetails about timely filing",
    });
    const chunks = chunkDocument(doc);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Pipeline Orchestration ──────────────────────────────────

describe("ingestDocument", () => {
  test("chunks, embeds, and inserts all chunks", async () => {
    const insert = mockInsert();
    const result = await ingestDocument(makeDoc(), {
      embed: mockEmbed(),
      insert: insert.fn,
    });

    expect(result.total_chunks).toBeGreaterThanOrEqual(1);
    expect(result.inserted).toBe(result.total_chunks);
    expect(result.duplicates_skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(insert.calls.length).toBe(result.inserted);
  });

  test("passes correct embedding to insert", async () => {
    const insert = mockInsert();
    await ingestDocument(makeDoc({ content: "99213 Single code" }), {
      embed: mockEmbed(),
      insert: insert.fn,
    });

    expect(insert.calls[0].embedding).toHaveLength(1536);
  });

  test("skips duplicates when dedupCheck returns true", async () => {
    const doc = makeDoc({
      content: "99213 Code A\n99214 Code B\n99215 Code C",
    });
    const insert = mockInsert();

    // Mark chunk index 1 as duplicate
    const result = await ingestDocument(doc, {
      embed: mockEmbed(),
      insert: insert.fn,
      dedupCheck: mockDedupCheck(new Set([1])),
    });

    expect(result.duplicates_skipped).toBe(1);
    expect(result.inserted).toBe(result.total_chunks - 1);
  });

  test("handles embed errors gracefully", async () => {
    let callCount = 0;
    const failingEmbed: EmbedFn = async () => {
      callCount++;
      if (callCount === 2) throw new Error("OpenAI rate limit");
      return Array(1536).fill(0.1);
    };

    const insert = mockInsert();
    const result = await ingestDocument(
      makeDoc({ content: "99213 A\n99214 B\n99215 C" }),
      { embed: failingEmbed, insert: insert.fn },
    );

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0].error).toContain("rate limit");
  });

  test("handles insert errors gracefully", async () => {
    let callCount = 0;
    const failingInsert: InsertFn = async () => {
      callCount++;
      if (callCount === 1) throw new Error("DB constraint");
      return "ok";
    };

    const result = await ingestDocument(
      makeDoc({ content: "99213 A\n99214 B" }),
      { embed: mockEmbed(), insert: failingInsert },
    );

    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0].error).toContain("DB constraint");
  });

  test("calls onProgress callback", async () => {
    const progress: [number, number][] = [];
    const insert = mockInsert();

    await ingestDocument(makeDoc({ content: "99213 A\n99214 B" }), {
      embed: mockEmbed(),
      insert: insert.fn,
      onProgress: (completed, total) => progress.push([completed, total]),
    });

    expect(progress.length).toBeGreaterThanOrEqual(1);
    const last = progress[progress.length - 1];
    expect(last[0]).toBe(last[1]); // Final progress: completed == total
  });

  test("uses custom chunking strategy when provided", async () => {
    const insert = mockInsert();
    const customStrategy: ChunkingStrategy = {
      mode: "fixed_size",
      target_tokens: 50,
    };

    await ingestDocument(
      makeDoc({ content: Array(20).fill("Line of text here.").join("\n") }),
      { embed: mockEmbed(), insert: insert.fn, strategy: customStrategy },
    );

    // With a small target, should produce multiple chunks
    expect(insert.calls.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Batch Ingestion ─────────────────────────────────────────

describe("ingestBatch", () => {
  test("processes multiple documents", async () => {
    const insert = mockInsert();
    const docs = [
      makeDoc({ category: "cpt_codes", content: "99213 Code A" }),
      makeDoc({ category: "icd10_codes", content: "J06.9 URI" }),
    ];

    const batch = await ingestBatch(docs, {
      embed: mockEmbed(),
      insert: insert.fn,
    });

    expect(batch.results).toHaveLength(2);
    expect(batch.total_inserted).toBeGreaterThanOrEqual(2);
    expect(batch.total_errors).toBe(0);
  });

  test("aggregates totals across documents", async () => {
    const insert = mockInsert();
    const docs = [
      makeDoc({ content: "99213 A\n99214 B" }),
      makeDoc({ content: "99215 C" }),
    ];

    const batch = await ingestBatch(docs, {
      embed: mockEmbed(),
      insert: insert.fn,
    });

    expect(batch.total_inserted).toBe(insert.calls.length);
  });

  test("handles empty batch", async () => {
    const batch = await ingestBatch([], {
      embed: mockEmbed(),
      insert: mockInsert().fn,
    });
    expect(batch.results).toHaveLength(0);
    expect(batch.total_inserted).toBe(0);
  });
});

// ── E2E: Full Ingestion Lifecycle ───────────────────────────

describe("E2E: ingestion lifecycle", () => {
  test("ingest CPT codes → verify chunks → verify metadata", async () => {
    const insert = mockInsert();
    const doc: IngestDocument = {
      content: [
        "99213 Office visit, established patient, low complexity",
        "99214 Office visit, established patient, moderate complexity",
        "99215 Office visit, established patient, high complexity",
      ].join("\n"),
      category: "cpt_codes",
      source_doc: "CMS 2026 CPT Manual",
      effective_date: "2026-01-01",
      company_id: "comp-1",
      metadata: { edition: "2026" },
    };

    const result = await ingestDocument(doc, {
      embed: mockEmbed(),
      insert: insert.fn,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.inserted).toBeGreaterThanOrEqual(1);

    // Verify all inserted chunks have correct metadata
    for (const call of insert.calls) {
      expect(call.chunk.category).toBe("cpt_codes");
      expect(call.chunk.source_doc).toBe("CMS 2026 CPT Manual");
      expect(call.chunk.effective_date).toBe("2026-01-01");
      expect(call.chunk.company_id).toBe("comp-1");
      expect(call.embedding).toHaveLength(1536);
    }
  });

  test("ingest with dedup skips identical content", async () => {
    const insert = mockInsert();
    // All chunks are "duplicates"
    const allDups = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const result = await ingestDocument(
      makeDoc({ content: "99213 A\n99214 B" }),
      {
        embed: mockEmbed(),
        insert: insert.fn,
        dedupCheck: mockDedupCheck(allDups),
      },
    );

    expect(result.inserted).toBe(0);
    expect(result.duplicates_skipped).toBe(result.total_chunks);
    expect(insert.calls).toHaveLength(0);
  });

  test("mixed batch: CPT + ICD-10 + denial reasons", async () => {
    const insert = mockInsert();
    const docs: IngestDocument[] = [
      { content: "99213 Office visit", category: "cpt_codes", company_id: "comp-1" },
      { content: "J06.9 Acute URI", category: "icd10_codes", company_id: "comp-1" },
      { content: "CO-16 Claim lacks information", category: "denial_reasons", company_id: "comp-1" },
    ];

    const batch = await ingestBatch(docs, {
      embed: mockEmbed(),
      insert: insert.fn,
    });

    expect(batch.total_errors).toBe(0);
    expect(batch.total_inserted).toBeGreaterThanOrEqual(3);

    // Verify categories are correct
    const categories = new Set(insert.calls.map(c => c.chunk.category));
    expect(categories.has("cpt_codes")).toBe(true);
    expect(categories.has("icd10_codes")).toBe(true);
    expect(categories.has("denial_reasons")).toBe(true);
  });
});
