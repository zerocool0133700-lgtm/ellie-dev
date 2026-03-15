/**
 * Medical Knowledge Tests — ELLIE-736
 *
 * Tests for medical billing reference data:
 * - Migration SQL structure
 * - Constants and validation
 * - CRUD operations
 * - Query with filters (category, company, payer)
 * - Semantic search
 * - Aggregation (count by category, latest effective dates)
 * - E2E lifecycle
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import type {
  MedicalKnowledgeEntry,
  MedicalKnowledgeCategory,
  SemanticSearchResult,
} from "../src/medical-knowledge.ts";

// ── Mock SQL Layer ──────────────────────────────────────────

type SqlRow = Record<string, unknown>;
type SqlResult = SqlRow[];

let sqlMockResults: SqlResult[] = [];
let sqlCallIndex = 0;
let sqlCalls: { strings: TemplateStringsArray; values: unknown[] }[] = [];

function resetSqlMock() {
  sqlMockResults = [];
  sqlCallIndex = 0;
  sqlCalls = [];
}

function pushSqlResult(rows: SqlResult) {
  sqlMockResults.push(rows);
}

const mockSql = Object.assign(
  function sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlResult> {
    sqlCalls.push({ strings, values });
    const result = sqlMockResults[sqlCallIndex] ?? [];
    sqlCallIndex++;
    return Promise.resolve(result);
  },
  { json: (v: unknown) => v, array: (v: unknown) => v },
);

mock.module("../../ellie-forest/src/index", () => ({
  sql: mockSql,
}));

const {
  createEntry,
  getEntry,
  updateEntry,
  deleteEntry,
  queryKnowledge,
  semanticSearch,
  countByCategory,
  getLatestEffectiveDates,
  isValidCategory,
  validateInput,
  VALID_CATEGORIES,
} = await import("../src/medical-knowledge.ts");

// ── Setup ───────────────────────────────────────────────────

beforeEach(() => {
  resetSqlMock();
});

// ── Helpers ─────────────────────────────────────────────────

function makeEntry(overrides: Partial<MedicalKnowledgeEntry> = {}): MedicalKnowledgeEntry {
  return {
    id: "mk-1",
    created_at: new Date(),
    updated_at: new Date(),
    category: "cpt_codes",
    subcategory: "evaluation",
    content: "99213 - Office visit, established patient, low complexity",
    embedding: null,
    source_doc: "CMS 2026 CPT Manual",
    effective_date: "2026-01-01",
    payer_id: null,
    company_id: "comp-1",
    metadata: {},
    ...overrides,
  };
}

// ── Migration SQL ───────────────────────────────────────────

describe("migration SQL", () => {
  function readMigration(): string {
    return readFileSync(
      join(import.meta.dir, "../migrations/supabase/20260315_medical_knowledge.sql"),
      "utf-8",
    );
  }

  test("enables pgvector extension", () => {
    expect(readMigration()).toContain("CREATE EXTENSION IF NOT EXISTS vector");
  });

  test("creates medical_knowledge table", () => {
    expect(readMigration()).toContain("CREATE TABLE IF NOT EXISTS medical_knowledge");
  });

  test("has category CHECK constraint with all 7 categories", () => {
    const sql = readMigration();
    for (const cat of VALID_CATEGORIES) {
      expect(sql).toContain(`'${cat}'`);
    }
  });

  test("has embedding vector(1536) column", () => {
    expect(readMigration()).toContain("embedding vector(1536)");
  });

  test("has company_id FK to companies", () => {
    expect(readMigration()).toContain("company_id UUID REFERENCES companies(id)");
  });

  test("has indexes for category, payer, company, effective date", () => {
    const sql = readMigration();
    expect(sql).toContain("idx_medical_knowledge_category");
    expect(sql).toContain("idx_medical_knowledge_payer");
    expect(sql).toContain("idx_medical_knowledge_company");
    expect(sql).toContain("idx_medical_knowledge_effective");
  });

  test("has composite category+company index", () => {
    expect(readMigration()).toContain("idx_medical_knowledge_category_company");
  });

  test("has IVFFlat index for semantic search", () => {
    const sql = readMigration();
    expect(sql).toContain("idx_medical_knowledge_embedding");
    expect(sql).toContain("ivfflat");
    expect(sql).toContain("vector_cosine_ops");
  });

  test("has RLS enabled", () => {
    expect(readMigration()).toContain("ENABLE ROW LEVEL SECURITY");
  });
});

// ── Constants ───────────────────────────────────────────────

describe("constants", () => {
  test("VALID_CATEGORIES has all 7 categories", () => {
    expect(VALID_CATEGORIES).toHaveLength(7);
    expect(VALID_CATEGORIES).toContain("cpt_codes");
    expect(VALID_CATEGORIES).toContain("icd10_codes");
    expect(VALID_CATEGORIES).toContain("payer_rules");
    expect(VALID_CATEGORIES).toContain("denial_reasons");
    expect(VALID_CATEGORIES).toContain("appeal_templates");
    expect(VALID_CATEGORIES).toContain("compliance");
    expect(VALID_CATEGORIES).toContain("fee_schedules");
  });
});

// ── isValidCategory (Pure) ──────────────────────────────────

describe("isValidCategory", () => {
  test("valid categories return true", () => {
    for (const cat of VALID_CATEGORIES) {
      expect(isValidCategory(cat)).toBe(true);
    }
  });

  test("invalid categories return false", () => {
    expect(isValidCategory("invalid")).toBe(false);
    expect(isValidCategory("")).toBe(false);
    expect(isValidCategory("CPT_CODES")).toBe(false);
  });
});

// ── validateInput (Pure) ────────────────────────────────────

describe("validateInput", () => {
  test("valid input passes", () => {
    const errors = validateInput({ category: "cpt_codes", content: "99213 - Office visit" });
    expect(errors).toHaveLength(0);
  });

  test("invalid category fails", () => {
    const errors = validateInput({ category: "invalid" as any, content: "test" });
    expect(errors.some(e => e.includes("Invalid category"))).toBe(true);
  });

  test("empty content fails", () => {
    const errors = validateInput({ category: "cpt_codes", content: "" });
    expect(errors.some(e => e.includes("content"))).toBe(true);
  });

  test("invalid effective_date fails", () => {
    const errors = validateInput({
      category: "cpt_codes",
      content: "test",
      effective_date: "not-a-date",
    });
    expect(errors.some(e => e.includes("effective_date"))).toBe(true);
  });

  test("valid effective_date passes", () => {
    const errors = validateInput({
      category: "cpt_codes",
      content: "test",
      effective_date: "2026-01-01",
    });
    expect(errors).toHaveLength(0);
  });
});

// ── createEntry ─────────────────────────────────────────────

describe("createEntry", () => {
  test("inserts and returns entry", async () => {
    pushSqlResult([makeEntry()]);

    const entry = await createEntry({
      category: "cpt_codes",
      content: "99213 - Office visit",
      subcategory: "evaluation",
      source_doc: "CMS 2026 CPT Manual",
      effective_date: "2026-01-01",
      company_id: "comp-1",
    });
    expect(entry.category).toBe("cpt_codes");
    expect(entry.content).toContain("99213");
  });

  test("handles minimal input", async () => {
    pushSqlResult([makeEntry({ subcategory: null, source_doc: null })]);

    const entry = await createEntry({ category: "payer_rules", content: "Rule text" });
    expect(entry.category).toBe("cpt_codes"); // from mock
  });

  test("SQL inserts into medical_knowledge", async () => {
    pushSqlResult([makeEntry()]);
    await createEntry({ category: "cpt_codes", content: "test" });
    expect(sqlCalls[0].strings.join("?")).toContain("INSERT INTO medical_knowledge");
  });
});

// ── getEntry ────────────────────────────────────────────────

describe("getEntry", () => {
  test("returns entry when found", async () => {
    pushSqlResult([makeEntry()]);
    const entry = await getEntry("mk-1");
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe("mk-1");
  });

  test("returns null when not found", async () => {
    pushSqlResult([]);
    expect(await getEntry("nonexistent")).toBeNull();
  });
});

// ── updateEntry ─────────────────────────────────────────────

describe("updateEntry", () => {
  test("updates content and clears embedding", async () => {
    pushSqlResult([makeEntry()]); // getEntry
    pushSqlResult([makeEntry({ content: "Updated content", embedding: null })]);

    const entry = await updateEntry("mk-1", { content: "Updated content" });
    expect(entry).not.toBeNull();

    // Should set embedding = NULL to trigger re-embedding
    const updateSql = sqlCalls[1].strings.join("?");
    expect(updateSql).toContain("embedding = NULL");
  });

  test("returns null for nonexistent entry", async () => {
    pushSqlResult([]); // getEntry returns null
    expect(await updateEntry("nonexistent", { content: "x" })).toBeNull();
  });
});

// ── deleteEntry ─────────────────────────────────────────────

describe("deleteEntry", () => {
  test("returns true when deleted", async () => {
    pushSqlResult([{ id: "mk-1" }]);
    expect(await deleteEntry("mk-1")).toBe(true);
  });

  test("returns false when not found", async () => {
    pushSqlResult([]);
    expect(await deleteEntry("nonexistent")).toBe(false);
  });
});

// ── queryKnowledge ──────────────────────────────────────────

describe("queryKnowledge", () => {
  test("returns all with no filters", async () => {
    pushSqlResult([makeEntry(), makeEntry({ id: "mk-2" })]);
    const results = await queryKnowledge();
    expect(results).toHaveLength(2);
  });

  test("filters by category", async () => {
    pushSqlResult([makeEntry()]);
    await queryKnowledge({ category: "cpt_codes" });
    expect(sqlCalls[0].strings.join("?")).toContain("category =");
  });

  test("filters by category + company", async () => {
    pushSqlResult([]);
    await queryKnowledge({ category: "payer_rules", company_id: "comp-1" });
    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("category =");
    expect(sqlText).toContain("company_id =");
  });

  test("filters by category + payer", async () => {
    pushSqlResult([]);
    await queryKnowledge({ category: "fee_schedules", payer_id: "aetna" });
    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("payer_id =");
  });

  test("filters by category + company + payer", async () => {
    pushSqlResult([]);
    await queryKnowledge({ category: "payer_rules", company_id: "comp-1", payer_id: "aetna" });
    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("category =");
    expect(sqlText).toContain("company_id =");
    expect(sqlText).toContain("payer_id =");
  });

  test("filters by company only", async () => {
    pushSqlResult([]);
    await queryKnowledge({ company_id: "comp-1" });
    expect(sqlCalls[0].strings.join("?")).toContain("company_id =");
  });

  test("uses default limit 50", async () => {
    pushSqlResult([]);
    await queryKnowledge();
    expect(sqlCalls[0].values).toContain(50);
  });

  test("accepts custom limit and offset", async () => {
    pushSqlResult([]);
    await queryKnowledge({ limit: 10, offset: 20 });
    expect(sqlCalls[0].values).toContain(10);
    expect(sqlCalls[0].values).toContain(20);
  });
});

// ── semanticSearch ──────────────────────────────────────────

describe("semanticSearch", () => {
  const fakeEmbedding = Array(1536).fill(0.1);

  test("returns results with similarity scores", async () => {
    pushSqlResult([{
      id: "mk-1", category: "cpt_codes", subcategory: "evaluation",
      content: "99213 - Office visit", source_doc: "CMS", payer_id: null,
      similarity: 0.92,
    }]);

    const results = await semanticSearch(fakeEmbedding);
    expect(results).toHaveLength(1);
    expect(results[0].similarity).toBe(0.92);
  });

  test("filters by category", async () => {
    pushSqlResult([]);
    await semanticSearch(fakeEmbedding, { category: "denial_reasons" });
    expect(sqlCalls[0].strings.join("?")).toContain("category =");
  });

  test("filters by category + company", async () => {
    pushSqlResult([]);
    await semanticSearch(fakeEmbedding, { category: "payer_rules", company_id: "comp-1" });
    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("category =");
    expect(sqlText).toContain("company_id =");
  });

  test("uses cosine distance operator", async () => {
    pushSqlResult([]);
    await semanticSearch(fakeEmbedding);
    expect(sqlCalls[0].strings.join("?")).toContain("<=>");
  });

  test("uses default limit 10 and min_similarity 0.5", async () => {
    pushSqlResult([]);
    await semanticSearch(fakeEmbedding);
    expect(sqlCalls[0].values).toContain(10);
    expect(sqlCalls[0].values).toContain(0.5);
  });

  test("accepts custom limit and min_similarity", async () => {
    pushSqlResult([]);
    await semanticSearch(fakeEmbedding, { limit: 5, min_similarity: 0.8 });
    expect(sqlCalls[0].values).toContain(5);
    expect(sqlCalls[0].values).toContain(0.8);
  });
});

// ── countByCategory ─────────────────────────────────────────

describe("countByCategory", () => {
  test("returns counts per category", async () => {
    pushSqlResult([
      { category: "cpt_codes", count: 150 },
      { category: "icd10_codes", count: 300 },
      { category: "payer_rules", count: 45 },
    ]);

    const counts = await countByCategory();
    expect(counts).toHaveLength(3);
    expect(counts[0].count).toBe(150);
  });

  test("scopes to company when provided", async () => {
    pushSqlResult([]);
    await countByCategory("comp-1");
    expect(sqlCalls[0].strings.join("?")).toContain("company_id =");
  });

  test("no company filter when omitted", async () => {
    pushSqlResult([]);
    await countByCategory();
    expect(sqlCalls[0].strings.join("?")).not.toContain("company_id");
  });
});

// ── getLatestEffectiveDates ─────────────────────────────────

describe("getLatestEffectiveDates", () => {
  test("returns latest date per category", async () => {
    pushSqlResult([
      { category: "cpt_codes", latest: "2026-01-01" },
      { category: "fee_schedules", latest: "2025-10-01" },
    ]);

    const dates = await getLatestEffectiveDates();
    expect(dates).toHaveLength(2);
    expect(dates[0].latest).toBe("2026-01-01");
  });

  test("scopes to company when provided", async () => {
    pushSqlResult([]);
    await getLatestEffectiveDates("comp-1");
    expect(sqlCalls[0].strings.join("?")).toContain("company_id =");
  });
});

// ── E2E: Medical Knowledge Lifecycle ────────────────────────

describe("E2E: medical knowledge lifecycle", () => {
  test("validate → create → query → semantic search → count", async () => {
    // Step 1: Validate input
    const errors = validateInput({
      category: "cpt_codes",
      content: "99213 - Office visit, established patient, low complexity",
      effective_date: "2026-01-01",
    });
    expect(errors).toHaveLength(0);

    // Step 2: Create entry
    pushSqlResult([makeEntry()]);
    const entry = await createEntry({
      category: "cpt_codes",
      content: "99213 - Office visit, established patient, low complexity",
      subcategory: "evaluation",
      source_doc: "CMS 2026 CPT Manual",
      effective_date: "2026-01-01",
      company_id: "comp-1",
    });
    expect(entry.category).toBe("cpt_codes");

    resetSqlMock();

    // Step 3: Query by category
    pushSqlResult([makeEntry()]);
    const results = await queryKnowledge({ category: "cpt_codes", company_id: "comp-1" });
    expect(results).toHaveLength(1);

    resetSqlMock();

    // Step 4: Semantic search
    pushSqlResult([{
      id: "mk-1", category: "cpt_codes", subcategory: "evaluation",
      content: "99213 - Office visit", source_doc: "CMS", payer_id: null,
      similarity: 0.95,
    }]);
    const searchResults = await semanticSearch(
      Array(1536).fill(0.1),
      { category: "cpt_codes", company_id: "comp-1" },
    );
    expect(searchResults).toHaveLength(1);
    expect(searchResults[0].similarity).toBe(0.95);

    resetSqlMock();

    // Step 5: Count by category
    pushSqlResult([{ category: "cpt_codes", count: 1 }]);
    const counts = await countByCategory("comp-1");
    expect(counts[0].count).toBe(1);
  });

  test("create → update (clears embedding) → delete", async () => {
    // Create
    pushSqlResult([makeEntry()]);
    await createEntry({ category: "payer_rules", content: "Original rule" });

    resetSqlMock();

    // Update content — embedding should be cleared for re-generation
    pushSqlResult([makeEntry()]);
    pushSqlResult([makeEntry({ content: "Updated rule", embedding: null })]);
    const updated = await updateEntry("mk-1", { content: "Updated rule" });
    expect(updated).not.toBeNull();

    resetSqlMock();

    // Delete
    pushSqlResult([{ id: "mk-1" }]);
    expect(await deleteEntry("mk-1")).toBe(true);
  });
});

// ── SQL Safety ──────────────────────────────────────────────

describe("SQL safety", () => {
  test("createEntry uses parameterized queries", async () => {
    pushSqlResult([makeEntry()]);
    await createEntry({ category: "cpt_codes", content: "test content" });

    const rawSql = sqlCalls[0].strings.join("");
    expect(rawSql).not.toContain("test content");
    expect(rawSql).not.toContain("cpt_codes");
  });

  test("semanticSearch uses parameterized embedding", async () => {
    pushSqlResult([]);
    await semanticSearch(Array(1536).fill(0.1));

    // Embedding string should be a parameter value, not in the SQL template
    expect(sqlCalls[0].values.length).toBeGreaterThan(0);
  });
});
