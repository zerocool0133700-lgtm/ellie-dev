/**
 * Medical Knowledge — ELLIE-736
 *
 * Domain-specific medical billing reference data with pgvector
 * semantic search. Separate from conversational memory.
 *
 * Categories: CPT codes, ICD-10 codes, payer rules, denial reasons,
 * appeal templates, compliance, fee schedules.
 */

import { sql } from "../../ellie-forest/src/index";

// ── Types ────────────────────────────────────────────────────

export type MedicalKnowledgeCategory =
  | "cpt_codes"
  | "icd10_codes"
  | "payer_rules"
  | "denial_reasons"
  | "appeal_templates"
  | "compliance"
  | "fee_schedules";

export const VALID_CATEGORIES: MedicalKnowledgeCategory[] = [
  "cpt_codes",
  "icd10_codes",
  "payer_rules",
  "denial_reasons",
  "appeal_templates",
  "compliance",
  "fee_schedules",
];

export interface MedicalKnowledgeEntry {
  id: string;
  created_at: Date;
  updated_at: Date;
  category: MedicalKnowledgeCategory;
  subcategory: string | null;
  content: string;
  embedding: number[] | null;
  source_doc: string | null;
  effective_date: string | null;
  payer_id: string | null;
  company_id: string | null;
  metadata: Record<string, unknown>;
}

export interface CreateKnowledgeInput {
  category: MedicalKnowledgeCategory;
  content: string;
  subcategory?: string;
  source_doc?: string;
  effective_date?: string;
  payer_id?: string;
  company_id?: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeQueryOptions {
  category?: MedicalKnowledgeCategory;
  subcategory?: string;
  payer_id?: string;
  company_id?: string;
  limit?: number;
  offset?: number;
}

export interface SemanticSearchResult {
  id: string;
  category: MedicalKnowledgeCategory;
  subcategory: string | null;
  content: string;
  source_doc: string | null;
  payer_id: string | null;
  similarity: number;
}

// ── CRUD ────────────────────────────────────────────────────

/**
 * Insert a medical knowledge entry.
 * Embedding is generated asynchronously via webhook on INSERT.
 */
export async function createEntry(input: CreateKnowledgeInput): Promise<MedicalKnowledgeEntry> {
  const [entry] = await sql<MedicalKnowledgeEntry[]>`
    INSERT INTO medical_knowledge (
      category, subcategory, content, source_doc,
      effective_date, payer_id, company_id, metadata
    )
    VALUES (
      ${input.category},
      ${input.subcategory ?? null},
      ${input.content},
      ${input.source_doc ?? null},
      ${input.effective_date ?? null},
      ${input.payer_id ?? null},
      ${input.company_id ?? null}::uuid,
      ${sql.json(input.metadata ?? {})}
    )
    RETURNING *
  `;
  return entry;
}

/**
 * Get an entry by ID.
 */
export async function getEntry(id: string): Promise<MedicalKnowledgeEntry | null> {
  const [entry] = await sql<MedicalKnowledgeEntry[]>`
    SELECT * FROM medical_knowledge WHERE id = ${id}::uuid
  `;
  return entry ?? null;
}

/**
 * Update an entry's content and metadata.
 */
export async function updateEntry(
  id: string,
  updates: { content?: string; subcategory?: string; metadata?: Record<string, unknown> },
): Promise<MedicalKnowledgeEntry | null> {
  const current = await getEntry(id);
  if (!current) return null;

  const [entry] = await sql<MedicalKnowledgeEntry[]>`
    UPDATE medical_knowledge
    SET
      content = ${updates.content ?? current.content},
      subcategory = ${updates.subcategory ?? current.subcategory},
      metadata = ${sql.json(updates.metadata ?? current.metadata)},
      embedding = NULL,
      updated_at = NOW()
    WHERE id = ${id}::uuid
    RETURNING *
  `;
  return entry ?? null;
}

/**
 * Delete an entry.
 */
export async function deleteEntry(id: string): Promise<boolean> {
  const rows = await sql`
    DELETE FROM medical_knowledge WHERE id = ${id}::uuid RETURNING id
  `;
  return rows.length > 0;
}

// ── Query ───────────────────────────────────────────────────

/**
 * Query knowledge entries with flexible filters.
 */
export async function queryKnowledge(opts: KnowledgeQueryOptions = {}): Promise<MedicalKnowledgeEntry[]> {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  if (opts.category && opts.company_id && opts.payer_id) {
    return sql<MedicalKnowledgeEntry[]>`
      SELECT * FROM medical_knowledge
      WHERE category = ${opts.category}
        AND company_id = ${opts.company_id}::uuid
        AND payer_id = ${opts.payer_id}
      ORDER BY effective_date DESC NULLS LAST, created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  if (opts.category && opts.company_id) {
    return sql<MedicalKnowledgeEntry[]>`
      SELECT * FROM medical_knowledge
      WHERE category = ${opts.category}
        AND company_id = ${opts.company_id}::uuid
      ORDER BY effective_date DESC NULLS LAST, created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  if (opts.category && opts.payer_id) {
    return sql<MedicalKnowledgeEntry[]>`
      SELECT * FROM medical_knowledge
      WHERE category = ${opts.category} AND payer_id = ${opts.payer_id}
      ORDER BY effective_date DESC NULLS LAST, created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  if (opts.category) {
    return sql<MedicalKnowledgeEntry[]>`
      SELECT * FROM medical_knowledge
      WHERE category = ${opts.category}
      ORDER BY effective_date DESC NULLS LAST, created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  if (opts.company_id) {
    return sql<MedicalKnowledgeEntry[]>`
      SELECT * FROM medical_knowledge
      WHERE company_id = ${opts.company_id}::uuid
      ORDER BY category, effective_date DESC NULLS LAST
      LIMIT ${limit} OFFSET ${offset}
    `;
  }

  return sql<MedicalKnowledgeEntry[]>`
    SELECT * FROM medical_knowledge
    ORDER BY category, effective_date DESC NULLS LAST
    LIMIT ${limit} OFFSET ${offset}
  `;
}

/**
 * Semantic search using pgvector cosine similarity.
 * Requires the embedding to be pre-computed by the caller.
 */
export async function semanticSearch(
  embedding: number[],
  opts: {
    category?: MedicalKnowledgeCategory;
    company_id?: string;
    payer_id?: string;
    limit?: number;
    min_similarity?: number;
  } = {},
): Promise<SemanticSearchResult[]> {
  const limit = opts.limit ?? 10;
  const minSim = opts.min_similarity ?? 0.5;
  const embeddingStr = `[${embedding.join(",")}]`;

  if (opts.category && opts.company_id) {
    return sql<SemanticSearchResult[]>`
      SELECT id, category, subcategory, content, source_doc, payer_id,
             1 - (embedding <=> ${embeddingStr}::vector) AS similarity
      FROM medical_knowledge
      WHERE embedding IS NOT NULL
        AND category = ${opts.category}
        AND company_id = ${opts.company_id}::uuid
        AND 1 - (embedding <=> ${embeddingStr}::vector) >= ${minSim}
      ORDER BY embedding <=> ${embeddingStr}::vector
      LIMIT ${limit}
    `;
  }

  if (opts.category) {
    return sql<SemanticSearchResult[]>`
      SELECT id, category, subcategory, content, source_doc, payer_id,
             1 - (embedding <=> ${embeddingStr}::vector) AS similarity
      FROM medical_knowledge
      WHERE embedding IS NOT NULL
        AND category = ${opts.category}
        AND 1 - (embedding <=> ${embeddingStr}::vector) >= ${minSim}
      ORDER BY embedding <=> ${embeddingStr}::vector
      LIMIT ${limit}
    `;
  }

  return sql<SemanticSearchResult[]>`
    SELECT id, category, subcategory, content, source_doc, payer_id,
           1 - (embedding <=> ${embeddingStr}::vector) AS similarity
    FROM medical_knowledge
    WHERE embedding IS NOT NULL
      AND 1 - (embedding <=> ${embeddingStr}::vector) >= ${minSim}
    ORDER BY embedding <=> ${embeddingStr}::vector
    LIMIT ${limit}
  `;
}

/**
 * Count entries by category (for dashboard stats).
 */
export async function countByCategory(
  companyId?: string,
): Promise<{ category: MedicalKnowledgeCategory; count: number }[]> {
  if (companyId) {
    return sql<{ category: MedicalKnowledgeCategory; count: number }[]>`
      SELECT category, COUNT(*)::int AS count
      FROM medical_knowledge
      WHERE company_id = ${companyId}::uuid
      GROUP BY category
      ORDER BY category
    `;
  }

  return sql<{ category: MedicalKnowledgeCategory; count: number }[]>`
    SELECT category, COUNT(*)::int AS count
    FROM medical_knowledge
    GROUP BY category
    ORDER BY category
  `;
}

/**
 * Get the latest effective date per category (for freshness checks).
 */
export async function getLatestEffectiveDates(
  companyId?: string,
): Promise<{ category: MedicalKnowledgeCategory; latest: string | null }[]> {
  if (companyId) {
    return sql<{ category: MedicalKnowledgeCategory; latest: string | null }[]>`
      SELECT category, MAX(effective_date)::text AS latest
      FROM medical_knowledge
      WHERE company_id = ${companyId}::uuid
      GROUP BY category
      ORDER BY category
    `;
  }

  return sql<{ category: MedicalKnowledgeCategory; latest: string | null }[]>`
    SELECT category, MAX(effective_date)::text AS latest
    FROM medical_knowledge
    GROUP BY category
    ORDER BY category
  `;
}

// ── Validation (Pure) ───────────────────────────────────────

/**
 * Validate a category string.
 */
export function isValidCategory(category: string): category is MedicalKnowledgeCategory {
  return VALID_CATEGORIES.includes(category as MedicalKnowledgeCategory);
}

/**
 * Validate a CreateKnowledgeInput.
 */
export function validateInput(input: CreateKnowledgeInput): string[] {
  const errors: string[] = [];

  if (!isValidCategory(input.category)) {
    errors.push(`Invalid category: ${input.category}. Valid: ${VALID_CATEGORIES.join(", ")}`);
  }
  if (!input.content?.trim()) {
    errors.push("content is required and must be non-empty");
  }
  if (input.effective_date && isNaN(new Date(input.effective_date).getTime())) {
    errors.push("effective_date must be a valid date string");
  }

  return errors;
}
