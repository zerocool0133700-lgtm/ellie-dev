/**
 * Medical Context Source — ELLIE-738
 *
 * Retrieval pipeline for medical_knowledge table.
 * Hybrid search (pgvector semantic + keyword), context window assembly,
 * and prompt injection for billing agents.
 *
 * Builds on ELLIE-736 (medical_knowledge table) and ELLIE-737 (ingestion).
 */

import type { MedicalKnowledgeCategory } from "../medical-knowledge";
import { VALID_CATEGORIES } from "../medical-knowledge";

// ── Types ────────────────────────────────────────────────────

/** Options for getMedicalContext. */
export interface MedicalContextOptions {
  payer_id?: string;
  company_id?: string;
  categories?: MedicalKnowledgeCategory[];
  limit?: number;
  min_similarity?: number;
}

/** A retrieved medical knowledge chunk with relevance score. */
export interface MedicalContextChunk {
  id: string;
  category: MedicalKnowledgeCategory;
  subcategory: string | null;
  content: string;
  source_doc: string | null;
  effective_date: string | null;
  payer_id: string | null;
  similarity: number;
  /** How this chunk was found: semantic, keyword, or both. */
  match_type: "semantic" | "keyword" | "hybrid";
}

/** The assembled context ready for prompt injection. */
export interface MedicalContextResult {
  chunks: MedicalContextChunk[];
  prompt_text: string;
  total_tokens_estimate: number;
  source_count: number;
  categories_used: MedicalKnowledgeCategory[];
}

/** Injected dependency: semantic search function. */
export type SemanticSearchFn = (
  embedding: number[],
  opts: { category?: MedicalKnowledgeCategory; company_id?: string; payer_id?: string; limit?: number; min_similarity?: number },
) => Promise<{ id: string; category: string; subcategory: string | null; content: string; source_doc: string | null; payer_id: string | null; similarity: number }[]>;

/** Injected dependency: keyword search function. */
export type KeywordSearchFn = (
  query: string,
  opts: { category?: MedicalKnowledgeCategory; company_id?: string; payer_id?: string; limit?: number },
) => Promise<{ id: string; category: string; subcategory: string | null; content: string; source_doc: string | null; payer_id: string | null; score: number }[]>;

/** Injected dependency: embed function. */
export type EmbedFn = (text: string) => Promise<number[]>;

/** Dependencies for getMedicalContext. */
export interface MedicalContextDeps {
  embed: EmbedFn;
  semanticSearch: SemanticSearchFn;
  keywordSearch?: KeywordSearchFn;
}

// ── Constants ───────────────────────────────────────────────

/** Default retrieval limit per search type. */
export const DEFAULT_LIMIT = 10;

/** Default minimum similarity for semantic search. */
export const DEFAULT_MIN_SIMILARITY = 0.5;

/** Approximate chars per token for estimation. */
const CHARS_PER_TOKEN = 4;

/** Weight for semantic results in hybrid ranking. */
export const SEMANTIC_WEIGHT = 0.7;

/** Weight for keyword results in hybrid ranking. */
export const KEYWORD_WEIGHT = 0.3;

// ── Core Retrieval ──────────────────────────────────────────

/**
 * Retrieve medical knowledge context for a query.
 *
 * Performs hybrid search (semantic + keyword if available),
 * merges and deduplicates results, ranks by combined score,
 * and assembles into a prompt-ready context block.
 */
export async function getMedicalContext(
  query: string,
  options: MedicalContextOptions,
  deps: MedicalContextDeps,
): Promise<MedicalContextResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const minSim = options.min_similarity ?? DEFAULT_MIN_SIMILARITY;
  const categories = options.categories ?? [];

  // Run searches in parallel (one per category, or all)
  const searchCategories = categories.length > 0 ? categories : [undefined];
  const allChunks: MedicalContextChunk[] = [];

  for (const cat of searchCategories) {
    // Semantic search
    const embedding = await deps.embed(query);
    const semanticResults = await deps.semanticSearch(embedding, {
      category: cat,
      company_id: options.company_id,
      payer_id: options.payer_id,
      limit,
      min_similarity: minSim,
    });

    for (const r of semanticResults) {
      allChunks.push({
        id: r.id,
        category: r.category as MedicalKnowledgeCategory,
        subcategory: r.subcategory,
        content: r.content,
        source_doc: r.source_doc,
        effective_date: null,
        payer_id: r.payer_id,
        similarity: r.similarity,
        match_type: "semantic",
      });
    }

    // Keyword search (if available)
    if (deps.keywordSearch) {
      const keywordResults = await deps.keywordSearch(query, {
        category: cat,
        company_id: options.company_id,
        payer_id: options.payer_id,
        limit,
      });

      for (const r of keywordResults) {
        const existing = allChunks.find(c => c.id === r.id);
        if (existing) {
          // Hybrid: seen in both semantic and keyword
          existing.match_type = "hybrid";
          existing.similarity = Math.max(existing.similarity, r.score);
        } else {
          allChunks.push({
            id: r.id,
            category: r.category as MedicalKnowledgeCategory,
            subcategory: r.subcategory,
            content: r.content,
            source_doc: r.source_doc,
            effective_date: null,
            payer_id: r.payer_id,
            similarity: r.score * (KEYWORD_WEIGHT / SEMANTIC_WEIGHT),
            match_type: "keyword",
          });
        }
      }
    }
  }

  // Deduplicate by ID
  const deduped = deduplicateChunks(allChunks);

  // Rank: hybrid > semantic > keyword, then by similarity DESC
  const ranked = rankChunks(deduped).slice(0, limit);

  // Assemble prompt context
  const promptText = assemblePromptContext(ranked);
  const tokensEstimate = Math.ceil(promptText.length / CHARS_PER_TOKEN);
  const categoriesUsed = [...new Set(ranked.map(c => c.category))];

  return {
    chunks: ranked,
    prompt_text: promptText,
    total_tokens_estimate: tokensEstimate,
    source_count: ranked.length,
    categories_used: categoriesUsed,
  };
}

// ── Deduplication ───────────────────────────────────────────

/**
 * Deduplicate chunks by ID, keeping the one with highest similarity.
 */
export function deduplicateChunks(chunks: MedicalContextChunk[]): MedicalContextChunk[] {
  const map = new Map<string, MedicalContextChunk>();

  for (const chunk of chunks) {
    const existing = map.get(chunk.id);
    if (!existing || chunk.similarity > existing.similarity) {
      map.set(chunk.id, chunk);
    }
  }

  return Array.from(map.values());
}

// ── Ranking ─────────────────────────────────────────────────

/**
 * Rank chunks: hybrid matches first, then by similarity DESC.
 */
export function rankChunks(chunks: MedicalContextChunk[]): MedicalContextChunk[] {
  return [...chunks].sort((a, b) => {
    // Hybrid > semantic > keyword
    const matchOrder = { hybrid: 0, semantic: 1, keyword: 2 };
    const orderDiff = matchOrder[a.match_type] - matchOrder[b.match_type];
    if (orderDiff !== 0) return orderDiff;

    // Then by similarity DESC
    return b.similarity - a.similarity;
  });
}

// ── Prompt Assembly ─────────────────────────────────────────

/**
 * Assemble retrieved chunks into a prompt context block.
 * Includes source metadata for agent transparency.
 *
 * Pure function — no side effects.
 */
export function assemblePromptContext(chunks: MedicalContextChunk[]): string {
  if (chunks.length === 0) return "";

  const lines: string[] = [
    "## Medical Knowledge Reference",
    "",
  ];

  // Group by category
  const byCategory = new Map<string, MedicalContextChunk[]>();
  for (const chunk of chunks) {
    const cat = chunk.category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(chunk);
  }

  for (const [category, catChunks] of byCategory) {
    const label = formatCategoryLabel(category);
    lines.push(`### ${label}`);
    lines.push("");

    for (const chunk of catChunks) {
      lines.push(chunk.content);
      const meta: string[] = [];
      if (chunk.source_doc) meta.push(`Source: ${chunk.source_doc}`);
      if (chunk.effective_date) meta.push(`Effective: ${chunk.effective_date}`);
      if (chunk.payer_id) meta.push(`Payer: ${chunk.payer_id}`);
      if (meta.length > 0) {
        lines.push(`  _${meta.join(" | ")}_`);
      }
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("Use the reference data above when answering billing questions.");

  return lines.join("\n");
}

/**
 * Format a category key into a human-readable label.
 */
export function formatCategoryLabel(category: string): string {
  const labels: Record<string, string> = {
    cpt_codes: "CPT Codes",
    icd10_codes: "ICD-10 Codes",
    payer_rules: "Payer Rules",
    denial_reasons: "Denial Reasons",
    appeal_templates: "Appeal Templates",
    compliance: "Compliance",
    fee_schedules: "Fee Schedules",
  };
  return labels[category] ?? category;
}

/**
 * Estimate the token cost of a context result.
 */
export function estimateContextTokens(result: MedicalContextResult): number {
  return result.total_tokens_estimate;
}

/**
 * Check if adding medical context would exceed a token budget.
 */
export function wouldExceedBudget(
  result: MedicalContextResult,
  currentTokens: number,
  maxTokens: number,
): boolean {
  return currentTokens + result.total_tokens_estimate > maxTokens;
}
