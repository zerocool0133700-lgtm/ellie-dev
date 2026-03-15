/**
 * Knowledge Ingestion Pipeline — ELLIE-737
 *
 * Chunking, embedding, dedup, and ingestion for medical billing
 * reference documents into the medical_knowledge table (ELLIE-736).
 *
 * Pure pipeline logic — embedding function and DB writes are injected
 * as dependencies so the core is fully testable.
 */

import type { MedicalKnowledgeCategory } from "./medical-knowledge";
import { VALID_CATEGORIES } from "./medical-knowledge";

// ── Types ────────────────────────────────────────────────────

/** A raw document to ingest. */
export interface IngestDocument {
  content: string;
  category: MedicalKnowledgeCategory;
  source_doc?: string;
  effective_date?: string;
  payer_id?: string;
  company_id?: string;
  metadata?: Record<string, unknown>;
}

/** A chunk produced by the chunking stage. */
export interface Chunk {
  content: string;
  category: MedicalKnowledgeCategory;
  subcategory: string | null;
  index: number;
  source_doc: string | null;
  effective_date: string | null;
  payer_id: string | null;
  company_id: string | null;
  metadata: Record<string, unknown>;
}

/** Configurable chunking strategy per category. */
export interface ChunkingStrategy {
  /** How to split the document. */
  mode: "per_line" | "per_code" | "per_section" | "fixed_size";
  /** Target chunk size in approximate tokens (for fixed_size). */
  target_tokens: number;
  /** Regex pattern to split on (for per_code, per_section). */
  split_pattern?: RegExp;
  /** Subcategory extractor (returns subcategory from a chunk). */
  subcategoryFn?: (chunk: string) => string | null;
}

/** Result of the full ingestion pipeline. */
export interface IngestionResult {
  total_chunks: number;
  inserted: number;
  duplicates_skipped: number;
  errors: IngestionError[];
  duration_ms: number;
}

export interface IngestionError {
  chunk_index: number;
  error: string;
}

/** Embedding function signature (cloud or local). */
export type EmbedFn = (text: string) => Promise<number[]>;

/** DB insert function signature (injected for testability). */
export type InsertFn = (chunk: Chunk, embedding: number[]) => Promise<string>;

/** Dedup check function signature (injected for testability). */
export type DedupCheckFn = (embedding: number[], category: MedicalKnowledgeCategory, companyId?: string) => Promise<boolean>;

/** Default dedup similarity threshold. */
export const DEDUP_THRESHOLD = 0.95;

/** Approximate tokens per character (rough heuristic). */
const CHARS_PER_TOKEN = 4;

// ── Chunking Strategies ─────────────────────────────────────

/** Default chunking strategies per category. */
export const DEFAULT_CHUNKING_STRATEGIES: Record<MedicalKnowledgeCategory, ChunkingStrategy> = {
  cpt_codes: {
    mode: "per_code",
    target_tokens: 200,
    split_pattern: /\n(?=\d{5})/,
    subcategoryFn: (chunk) => {
      const match = chunk.match(/^(\d{5})/);
      return match ? match[1] : null;
    },
  },
  icd10_codes: {
    mode: "per_code",
    target_tokens: 200,
    split_pattern: /\n(?=[A-Z]\d{2})/,
    subcategoryFn: (chunk) => {
      const match = chunk.match(/^([A-Z]\d{2}(?:\.\d{1,4})?)/);
      return match ? match[1] : null;
    },
  },
  payer_rules: {
    mode: "per_section",
    target_tokens: 500,
    split_pattern: /\n(?=(?:Rule|Section|Policy)\s*[:#\d])/i,
  },
  denial_reasons: {
    mode: "per_line",
    target_tokens: 300,
    split_pattern: /\n(?=(?:CO|PR|OA|PI|CR)-?\d)/,
    subcategoryFn: (chunk) => {
      const match = chunk.match(/^((?:CO|PR|OA|PI|CR)-?\d+)/);
      return match ? match[1] : null;
    },
  },
  appeal_templates: {
    mode: "per_section",
    target_tokens: 800,
    split_pattern: /\n(?=(?:Template|Appeal|Letter)\s*[:#\d])/i,
  },
  compliance: {
    mode: "per_section",
    target_tokens: 500,
    split_pattern: /\n(?=(?:Regulation|Section|Requirement)\s*[:#\d])/i,
  },
  fee_schedules: {
    mode: "per_line",
    target_tokens: 200,
    split_pattern: /\n(?=\d{5})/,
    subcategoryFn: (chunk) => {
      const match = chunk.match(/^(\d{5})/);
      return match ? match[1] : null;
    },
  },
};

// ── Chunking ────────────────────────────────────────────────

/**
 * Chunk a document using the configured strategy for its category.
 * Pure function — no side effects.
 */
export function chunkDocument(
  doc: IngestDocument,
  strategy?: ChunkingStrategy,
): Chunk[] {
  const strat = strategy ?? DEFAULT_CHUNKING_STRATEGIES[doc.category];
  const rawChunks = splitDocument(doc.content, strat);

  return rawChunks
    .map((content, index) => ({
      content: content.trim(),
      category: doc.category,
      subcategory: strat.subcategoryFn?.(content.trim()) ?? null,
      index,
      source_doc: doc.source_doc ?? null,
      effective_date: doc.effective_date ?? null,
      payer_id: doc.payer_id ?? null,
      company_id: doc.company_id ?? null,
      metadata: doc.metadata ?? {},
    }))
    .filter(c => c.content.length > 0);
}

/**
 * Split raw document text using a chunking strategy.
 */
function splitDocument(content: string, strategy: ChunkingStrategy): string[] {
  if (strategy.mode === "fixed_size") {
    return splitByTokenSize(content, strategy.target_tokens);
  }

  if (strategy.split_pattern) {
    const parts = content.split(strategy.split_pattern).filter(Boolean);
    // If parts are too large, sub-split by fixed size
    const result: string[] = [];
    for (const part of parts) {
      if (estimateTokens(part) > strategy.target_tokens * 2) {
        result.push(...splitByTokenSize(part, strategy.target_tokens));
      } else {
        result.push(part);
      }
    }
    return result;
  }

  // Fallback: split by double newlines
  return content.split(/\n\n+/).filter(Boolean);
}

/**
 * Split text into chunks of approximately target_tokens size.
 */
function splitByTokenSize(text: string, targetTokens: number): string[] {
  const targetChars = targetTokens * CHARS_PER_TOKEN;
  const chunks: string[] = [];
  const lines = text.split("\n");
  let current = "";

  for (const line of lines) {
    if (current.length + line.length + 1 > targetChars && current.length > 0) {
      chunks.push(current);
      current = line;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }

  if (current.trim()) chunks.push(current);
  return chunks;
}

/**
 * Estimate token count from character count.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ── Pipeline Orchestrator ───────────────────────────────────

/**
 * Run the full ingestion pipeline for a document.
 *
 * Embedding and DB functions are injected for testability.
 * In production, pass real OpenAI embed + Supabase insert.
 */
export async function ingestDocument(
  doc: IngestDocument,
  deps: {
    embed: EmbedFn;
    insert: InsertFn;
    dedupCheck?: DedupCheckFn;
    strategy?: ChunkingStrategy;
    onProgress?: (completed: number, total: number) => void;
  },
): Promise<IngestionResult> {
  const start = Date.now();
  const chunks = chunkDocument(doc, deps.strategy);

  let inserted = 0;
  let duplicatesSkipped = 0;
  const errors: IngestionError[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    try {
      // Embed
      const embedding = await deps.embed(chunk.content);

      // Dedup check
      if (deps.dedupCheck) {
        const isDuplicate = await deps.dedupCheck(
          embedding,
          chunk.category,
          chunk.company_id ?? undefined,
        );
        if (isDuplicate) {
          duplicatesSkipped++;
          deps.onProgress?.(i + 1, chunks.length);
          continue;
        }
      }

      // Insert
      await deps.insert(chunk, embedding);
      inserted++;
    } catch (err) {
      errors.push({
        chunk_index: i,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    deps.onProgress?.(i + 1, chunks.length);
  }

  return {
    total_chunks: chunks.length,
    inserted,
    duplicates_skipped: duplicatesSkipped,
    errors,
    duration_ms: Date.now() - start,
  };
}

/**
 * Ingest multiple documents in sequence.
 */
export async function ingestBatch(
  docs: IngestDocument[],
  deps: {
    embed: EmbedFn;
    insert: InsertFn;
    dedupCheck?: DedupCheckFn;
  },
): Promise<{ results: IngestionResult[]; total_inserted: number; total_errors: number }> {
  const results: IngestionResult[] = [];
  let totalInserted = 0;
  let totalErrors = 0;

  for (const doc of docs) {
    const result = await ingestDocument(doc, deps);
    results.push(result);
    totalInserted += result.inserted;
    totalErrors += result.errors.length;
  }

  return { results, total_inserted: totalInserted, total_errors: totalErrors };
}
