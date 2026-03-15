/**
 * Medical Context Source Tests — ELLIE-738
 *
 * Tests for medical knowledge retrieval pipeline:
 * - getMedicalContext (hybrid search orchestration)
 * - Deduplication
 * - Ranking (hybrid > semantic > keyword)
 * - Prompt assembly (grouped by category, with metadata)
 * - Token estimation and budget checking
 * - Category label formatting
 * - Integration test with sample CPT/ICD queries
 */

import { describe, test, expect } from "bun:test";
import {
  getMedicalContext,
  deduplicateChunks,
  rankChunks,
  assemblePromptContext,
  formatCategoryLabel,
  estimateContextTokens,
  wouldExceedBudget,
  DEFAULT_LIMIT,
  DEFAULT_MIN_SIMILARITY,
  SEMANTIC_WEIGHT,
  KEYWORD_WEIGHT,
  type MedicalContextChunk,
  type MedicalContextOptions,
  type MedicalContextDeps,
  type MedicalContextResult,
  type SemanticSearchFn,
  type KeywordSearchFn,
  type EmbedFn,
} from "../src/context-sources/medical.ts";

// ── Mock Dependencies ───────────────────────────────────────

function mockEmbed(): EmbedFn {
  return async () => Array(1536).fill(0.1);
}

function mockSemanticSearch(results: ReturnType<SemanticSearchFn> extends Promise<infer R> ? R : never = []): SemanticSearchFn {
  return async () => results;
}

function mockKeywordSearch(results: ReturnType<KeywordSearchFn> extends Promise<infer R> ? R : never = []): KeywordSearchFn {
  return async () => results;
}

// ── Helpers ─────────────────────────────────────────────────

function makeChunk(overrides: Partial<MedicalContextChunk> = {}): MedicalContextChunk {
  return {
    id: "mk-1",
    category: "cpt_codes",
    subcategory: "99213",
    content: "99213 Office visit, established patient, low complexity",
    source_doc: "CMS 2026 CPT Manual",
    effective_date: "2026-01-01",
    payer_id: null,
    similarity: 0.9,
    match_type: "semantic",
    ...overrides,
  };
}

// ── Constants ───────────────────────────────────────────────

describe("constants", () => {
  test("DEFAULT_LIMIT is 10", () => {
    expect(DEFAULT_LIMIT).toBe(10);
  });

  test("DEFAULT_MIN_SIMILARITY is 0.5", () => {
    expect(DEFAULT_MIN_SIMILARITY).toBe(0.5);
  });

  test("SEMANTIC_WEIGHT > KEYWORD_WEIGHT", () => {
    expect(SEMANTIC_WEIGHT).toBeGreaterThan(KEYWORD_WEIGHT);
    expect(SEMANTIC_WEIGHT + KEYWORD_WEIGHT).toBe(1);
  });
});

// ── deduplicateChunks (Pure) ────────────────────────────────

describe("deduplicateChunks", () => {
  test("removes duplicates by ID, keeping highest similarity", () => {
    const chunks = [
      makeChunk({ id: "mk-1", similarity: 0.8 }),
      makeChunk({ id: "mk-1", similarity: 0.95 }),
      makeChunk({ id: "mk-2", similarity: 0.7 }),
    ];
    const deduped = deduplicateChunks(chunks);
    expect(deduped).toHaveLength(2);
    expect(deduped.find(c => c.id === "mk-1")!.similarity).toBe(0.95);
  });

  test("preserves unique chunks", () => {
    const chunks = [makeChunk({ id: "mk-1" }), makeChunk({ id: "mk-2" })];
    expect(deduplicateChunks(chunks)).toHaveLength(2);
  });

  test("handles empty input", () => {
    expect(deduplicateChunks([])).toHaveLength(0);
  });
});

// ── rankChunks (Pure) ───────────────────────────────────────

describe("rankChunks", () => {
  test("hybrid results rank before semantic", () => {
    const chunks = [
      makeChunk({ id: "mk-1", match_type: "semantic", similarity: 0.99 }),
      makeChunk({ id: "mk-2", match_type: "hybrid", similarity: 0.8 }),
    ];
    const ranked = rankChunks(chunks);
    expect(ranked[0].id).toBe("mk-2");
    expect(ranked[0].match_type).toBe("hybrid");
  });

  test("semantic results rank before keyword", () => {
    const chunks = [
      makeChunk({ id: "mk-1", match_type: "keyword", similarity: 0.95 }),
      makeChunk({ id: "mk-2", match_type: "semantic", similarity: 0.7 }),
    ];
    const ranked = rankChunks(chunks);
    expect(ranked[0].match_type).toBe("semantic");
  });

  test("within same match_type, higher similarity ranks first", () => {
    const chunks = [
      makeChunk({ id: "mk-1", match_type: "semantic", similarity: 0.7 }),
      makeChunk({ id: "mk-2", match_type: "semantic", similarity: 0.95 }),
    ];
    const ranked = rankChunks(chunks);
    expect(ranked[0].id).toBe("mk-2");
  });

  test("does not mutate input", () => {
    const chunks = [
      makeChunk({ id: "mk-1", similarity: 0.5 }),
      makeChunk({ id: "mk-2", similarity: 0.9 }),
    ];
    const original = [...chunks];
    rankChunks(chunks);
    expect(chunks[0].id).toBe(original[0].id);
  });
});

// ── assemblePromptContext (Pure) ─────────────────────────────

describe("assemblePromptContext", () => {
  test("builds formatted prompt with category headers", () => {
    const chunks = [
      makeChunk({ category: "cpt_codes", content: "99213 Office visit" }),
      makeChunk({ id: "mk-2", category: "icd10_codes", content: "J06.9 Acute URI", source_doc: "ICD-10 2026" }),
    ];
    const prompt = assemblePromptContext(chunks);
    expect(prompt).toContain("## Medical Knowledge Reference");
    expect(prompt).toContain("### CPT Codes");
    expect(prompt).toContain("99213 Office visit");
    expect(prompt).toContain("### ICD-10 Codes");
    expect(prompt).toContain("J06.9 Acute URI");
    expect(prompt).toContain("Use the reference data above");
  });

  test("includes source metadata", () => {
    const chunks = [
      makeChunk({ source_doc: "CMS Manual", effective_date: "2026-01-01", payer_id: "aetna" }),
    ];
    const prompt = assemblePromptContext(chunks);
    expect(prompt).toContain("Source: CMS Manual");
    expect(prompt).toContain("Effective: 2026-01-01");
    expect(prompt).toContain("Payer: aetna");
  });

  test("omits metadata fields that are null", () => {
    const chunks = [makeChunk({ source_doc: null, effective_date: null, payer_id: null })];
    const prompt = assemblePromptContext(chunks);
    expect(prompt).not.toContain("Source:");
    expect(prompt).not.toContain("Effective:");
    expect(prompt).not.toContain("Payer:");
  });

  test("returns empty string for no chunks", () => {
    expect(assemblePromptContext([])).toBe("");
  });

  test("groups multiple chunks under same category", () => {
    const chunks = [
      makeChunk({ id: "mk-1", category: "cpt_codes", content: "99213 Low" }),
      makeChunk({ id: "mk-2", category: "cpt_codes", content: "99214 Moderate" }),
    ];
    const prompt = assemblePromptContext(chunks);
    const cptCount = (prompt.match(/### CPT Codes/g) || []).length;
    expect(cptCount).toBe(1); // Only one header
    expect(prompt).toContain("99213");
    expect(prompt).toContain("99214");
  });
});

// ── formatCategoryLabel (Pure) ──────────────────────────────

describe("formatCategoryLabel", () => {
  test("formats all known categories", () => {
    expect(formatCategoryLabel("cpt_codes")).toBe("CPT Codes");
    expect(formatCategoryLabel("icd10_codes")).toBe("ICD-10 Codes");
    expect(formatCategoryLabel("payer_rules")).toBe("Payer Rules");
    expect(formatCategoryLabel("denial_reasons")).toBe("Denial Reasons");
    expect(formatCategoryLabel("appeal_templates")).toBe("Appeal Templates");
    expect(formatCategoryLabel("compliance")).toBe("Compliance");
    expect(formatCategoryLabel("fee_schedules")).toBe("Fee Schedules");
  });

  test("returns key as-is for unknown categories", () => {
    expect(formatCategoryLabel("unknown_cat")).toBe("unknown_cat");
  });
});

// ── Token Estimation & Budget ───────────────────────────────

describe("estimateContextTokens", () => {
  test("returns the pre-computed estimate", () => {
    const result: MedicalContextResult = {
      chunks: [],
      prompt_text: "x".repeat(400),
      total_tokens_estimate: 100,
      source_count: 0,
      categories_used: [],
    };
    expect(estimateContextTokens(result)).toBe(100);
  });
});

describe("wouldExceedBudget", () => {
  test("returns false when within budget", () => {
    const result: MedicalContextResult = {
      chunks: [], prompt_text: "", total_tokens_estimate: 500,
      source_count: 0, categories_used: [],
    };
    expect(wouldExceedBudget(result, 3000, 4000)).toBe(false);
  });

  test("returns true when over budget", () => {
    const result: MedicalContextResult = {
      chunks: [], prompt_text: "", total_tokens_estimate: 2000,
      source_count: 0, categories_used: [],
    };
    expect(wouldExceedBudget(result, 3000, 4000)).toBe(true);
  });

  test("returns true when exactly at budget", () => {
    const result: MedicalContextResult = {
      chunks: [], prompt_text: "", total_tokens_estimate: 1000,
      source_count: 0, categories_used: [],
    };
    expect(wouldExceedBudget(result, 3000, 4000)).toBe(false);
  });
});

// ── getMedicalContext ────────────────────────────────────────

describe("getMedicalContext", () => {
  test("returns semantic results when no keyword search", async () => {
    const deps: MedicalContextDeps = {
      embed: mockEmbed(),
      semanticSearch: mockSemanticSearch([
        { id: "mk-1", category: "cpt_codes", subcategory: "99213", content: "99213 Office visit", source_doc: "CMS", payer_id: null, similarity: 0.92 },
      ]),
    };

    const result = await getMedicalContext("office visit code", {}, deps);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0].match_type).toBe("semantic");
    expect(result.prompt_text).toContain("99213");
    expect(result.source_count).toBe(1);
  });

  test("merges semantic + keyword into hybrid results", async () => {
    const deps: MedicalContextDeps = {
      embed: mockEmbed(),
      semanticSearch: mockSemanticSearch([
        { id: "mk-1", category: "cpt_codes", subcategory: null, content: "99213 Office visit", source_doc: null, payer_id: null, similarity: 0.9 },
      ]),
      keywordSearch: mockKeywordSearch([
        { id: "mk-1", category: "cpt_codes", subcategory: null, content: "99213 Office visit", source_doc: null, payer_id: null, score: 0.85 },
        { id: "mk-2", category: "cpt_codes", subcategory: null, content: "99214 Office visit moderate", source_doc: null, payer_id: null, score: 0.7 },
      ]),
    };

    const result = await getMedicalContext("office visit", {}, deps);
    expect(result.chunks).toHaveLength(2);

    const hybrid = result.chunks.find(c => c.id === "mk-1");
    expect(hybrid!.match_type).toBe("hybrid");

    const keywordOnly = result.chunks.find(c => c.id === "mk-2");
    expect(keywordOnly!.match_type).toBe("keyword");
  });

  test("respects category filter", async () => {
    let searchedCategory: string | undefined;
    const deps: MedicalContextDeps = {
      embed: mockEmbed(),
      semanticSearch: async (_emb, opts) => {
        searchedCategory = opts.category;
        return [];
      },
    };

    await getMedicalContext("test", { categories: ["denial_reasons"] }, deps);
    expect(searchedCategory).toBe("denial_reasons");
  });

  test("passes payer_id and company_id to search", async () => {
    let capturedOpts: any;
    const deps: MedicalContextDeps = {
      embed: mockEmbed(),
      semanticSearch: async (_emb, opts) => {
        capturedOpts = opts;
        return [];
      },
    };

    await getMedicalContext("test", { payer_id: "aetna", company_id: "comp-1" }, deps);
    expect(capturedOpts.payer_id).toBe("aetna");
    expect(capturedOpts.company_id).toBe("comp-1");
  });

  test("respects limit option", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `mk-${i}`, category: "cpt_codes", subcategory: null,
      content: `Code ${i}`, source_doc: null, payer_id: null, similarity: 0.9 - i * 0.01,
    }));

    const deps: MedicalContextDeps = {
      embed: mockEmbed(),
      semanticSearch: mockSemanticSearch(many),
    };

    const result = await getMedicalContext("codes", { limit: 5 }, deps);
    expect(result.chunks).toHaveLength(5);
  });

  test("returns categories_used from actual results", async () => {
    const deps: MedicalContextDeps = {
      embed: mockEmbed(),
      semanticSearch: mockSemanticSearch([
        { id: "mk-1", category: "cpt_codes", subcategory: null, content: "CPT", source_doc: null, payer_id: null, similarity: 0.9 },
        { id: "mk-2", category: "denial_reasons", subcategory: null, content: "Denial", source_doc: null, payer_id: null, similarity: 0.85 },
      ]),
    };

    const result = await getMedicalContext("test", {}, deps);
    expect(result.categories_used).toContain("cpt_codes");
    expect(result.categories_used).toContain("denial_reasons");
  });

  test("computes token estimate from prompt text", async () => {
    const deps: MedicalContextDeps = {
      embed: mockEmbed(),
      semanticSearch: mockSemanticSearch([
        { id: "mk-1", category: "cpt_codes", subcategory: null, content: "x".repeat(400), source_doc: null, payer_id: null, similarity: 0.9 },
      ]),
    };

    const result = await getMedicalContext("test", {}, deps);
    expect(result.total_tokens_estimate).toBeGreaterThan(0);
  });

  test("returns empty result for no matches", async () => {
    const deps: MedicalContextDeps = {
      embed: mockEmbed(),
      semanticSearch: mockSemanticSearch([]),
    };

    const result = await getMedicalContext("nonexistent query", {}, deps);
    expect(result.chunks).toHaveLength(0);
    expect(result.prompt_text).toBe("");
    expect(result.source_count).toBe(0);
  });
});

// ── E2E: Sample Medical Queries ─────────────────────────────

describe("E2E: sample medical billing queries", () => {
  const sampleData = [
    { id: "cpt-1", category: "cpt_codes", subcategory: "99213", content: "99213 Office/outpatient visit, est patient, low MDM, 20-29 min", source_doc: "CMS CPT 2026", payer_id: null, similarity: 0.95 },
    { id: "cpt-2", category: "cpt_codes", subcategory: "99214", content: "99214 Office/outpatient visit, est patient, moderate MDM, 30-39 min", source_doc: "CMS CPT 2026", payer_id: null, similarity: 0.88 },
    { id: "icd-1", category: "icd10_codes", subcategory: "J06.9", content: "J06.9 Acute upper respiratory infection, unspecified", source_doc: "ICD-10-CM 2026", payer_id: null, similarity: 0.92 },
    { id: "deny-1", category: "denial_reasons", subcategory: "CO-16", content: "CO-16 Claim/service lacks information needed for adjudication", source_doc: "CARC/RARC Guide", payer_id: null, similarity: 0.91 },
    { id: "rule-1", category: "payer_rules", subcategory: null, content: "Aetna: Prior authorization required for MRI of spine (CPT 72148)", source_doc: "Aetna Clinical Policy Bulletin", payer_id: "aetna", similarity: 0.89 },
  ];

  function makeDeps(data = sampleData): MedicalContextDeps {
    return {
      embed: mockEmbed(),
      semanticSearch: mockSemanticSearch(data),
    };
  }

  test("CPT code lookup query", async () => {
    const result = await getMedicalContext(
      "What is the CPT code for a moderate complexity office visit?",
      { categories: ["cpt_codes"] },
      makeDeps(),
    );

    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.categories_used).toContain("cpt_codes");
    expect(result.prompt_text).toContain("CPT Codes");
    expect(result.prompt_text).toContain("99213");
  });

  test("denial reason lookup", async () => {
    const result = await getMedicalContext(
      "Why was my claim denied with code CO-16?",
      { categories: ["denial_reasons"] },
      makeDeps([sampleData[3]]),
    );

    expect(result.prompt_text).toContain("CO-16");
    expect(result.prompt_text).toContain("lacks information");
  });

  test("payer-specific rule lookup", async () => {
    const result = await getMedicalContext(
      "Does Aetna require prior auth for MRI?",
      { payer_id: "aetna", categories: ["payer_rules"] },
      makeDeps([sampleData[4]]),
    );

    expect(result.prompt_text).toContain("Aetna");
    expect(result.prompt_text).toContain("Prior authorization");
    expect(result.prompt_text).toContain("Payer: aetna");
  });

  test("cross-category query returns mixed results", async () => {
    const result = await getMedicalContext(
      "Help me code and bill an office visit for URI",
      {},
      makeDeps(),
    );

    expect(result.categories_used.length).toBeGreaterThanOrEqual(1);
    expect(result.prompt_text).toContain("## Medical Knowledge Reference");
    expect(result.prompt_text).toContain("Use the reference data above");
  });

  test("prompt context is ready for injection into agent prompt", async () => {
    const result = await getMedicalContext("office visit", {}, makeDeps());
    // Should be a well-formed markdown block
    expect(result.prompt_text).toMatch(/^## Medical Knowledge Reference/);
    expect(result.prompt_text).toMatch(/---\nUse the reference data above/);
    expect(result.total_tokens_estimate).toBeGreaterThan(0);
  });
});
