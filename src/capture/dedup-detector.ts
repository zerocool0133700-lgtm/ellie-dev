/**
 * Deduplication & Conflict Detection — ELLIE-780
 * Checks proposed captures against existing River content before writing.
 * Pure functions with injected QMD search for testability.
 */

// Types

export type DedupClassification = "unique" | "duplicate" | "semantic_duplicate" | "conflict" | "supersedes";

export interface DedupResult {
  classification: DedupClassification;
  confidence: number;
  matched_doc?: MatchedDoc;
  reason: string;
  suggestion: string;
}

export interface MatchedDoc {
  path: string;
  title: string;
  content: string;
  similarity: number;
}

export interface QmdSearchResult {
  path: string;
  title?: string;
  content: string;
  score: number;
}

export interface QmdClient {
  search(query: string, options?: { minScore?: number; limit?: number }): Promise<QmdSearchResult[]>;
}

export interface DedupConfig {
  exact_threshold: number;
  semantic_threshold: number;
  conflict_threshold: number;
  max_results: number;
}

export const DEFAULT_DEDUP_CONFIG: DedupConfig = {
  exact_threshold: 0.95,
  semantic_threshold: 0.85,
  conflict_threshold: 0.7,
  max_results: 5,
};

// Exact text similarity (Jaccard on normalized word sets)

export function textSimilarity(a: string, b: string): number {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  const wordsA = new Set(normalize(a));
  const wordsB = new Set(normalize(b));

  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return intersection / union;
}

// Conflict detection heuristics

const CONTRADICTING_PAIRS = [
  ["always", "never"],
  ["must", "must not"],
  ["required", "optional"],
  ["enabled", "disabled"],
  ["use", "don't use"],
  ["allow", "deny"],
  ["include", "exclude"],
];

export function detectContradiction(newContent: string, existingContent: string): { isConflict: boolean; signals: string[] } {
  const newLower = newContent.toLowerCase();
  const existingLower = existingContent.toLowerCase();
  const signals: string[] = [];

  for (const [a, b] of CONTRADICTING_PAIRS) {
    if ((newLower.includes(a) && existingLower.includes(b)) ||
        (newLower.includes(b) && existingLower.includes(a))) {
      signals.push(`"${a}" vs "${b}"`);
    }
  }

  return { isConflict: signals.length > 0, signals };
}

// Supersession detection (new content is a newer version of existing)

export function detectSupersession(newContent: string, existingContent: string, similarity: number): boolean {
  // High similarity + new content is longer (adds detail) suggests update
  if (similarity >= 0.5 && similarity < 0.85) {
    const newLen = newContent.length;
    const existingLen = existingContent.length;
    // New content is significantly longer (>20% more) — likely an update
    if (newLen > existingLen * 1.2) return true;
  }
  return false;
}

// Main classification pipeline

export async function classifyCapture(
  newContent: string,
  qmd: QmdClient,
  config: DedupConfig = DEFAULT_DEDUP_CONFIG,
): Promise<DedupResult> {
  // Search for similar existing docs
  let results: QmdSearchResult[];
  try {
    results = await qmd.search(newContent, {
      minScore: config.conflict_threshold,
      limit: config.max_results,
    });
  } catch {
    // If search fails, assume unique (don't block the write)
    return {
      classification: "unique",
      confidence: 0.5,
      reason: "QMD search unavailable — assuming unique",
      suggestion: "Write as new document",
    };
  }

  if (results.length === 0) {
    return {
      classification: "unique",
      confidence: 0.95,
      reason: "No similar documents found in River",
      suggestion: "Write as new document",
    };
  }

  // Check best match
  const best = results[0];
  const exactSim = textSimilarity(newContent, best.content);

  // Exact duplicate
  if (exactSim >= config.exact_threshold) {
    return {
      classification: "duplicate",
      confidence: exactSim,
      matched_doc: {
        path: best.path,
        title: best.title ?? best.path,
        content: best.content,
        similarity: exactSim,
      },
      reason: `Near-identical content already exists at ${best.path} (${Math.round(exactSim * 100)}% match)`,
      suggestion: "Skip — content already captured",
    };
  }

  // Semantic duplicate (high QMD score but not exact)
  if (best.score >= config.semantic_threshold) {
    return {
      classification: "semantic_duplicate",
      confidence: best.score,
      matched_doc: {
        path: best.path,
        title: best.title ?? best.path,
        content: best.content,
        similarity: best.score,
      },
      reason: `Semantically similar content exists at ${best.path} (${Math.round(best.score * 100)}% semantic match)`,
      suggestion: "Review for merge — may be a duplicate with different wording",
    };
  }

  // Check for contradictions
  const { isConflict, signals } = detectContradiction(newContent, best.content);
  if (isConflict && best.score >= config.conflict_threshold) {
    return {
      classification: "conflict",
      confidence: best.score,
      matched_doc: {
        path: best.path,
        title: best.title ?? best.path,
        content: best.content,
        similarity: best.score,
      },
      reason: `Potential contradiction with ${best.path}: ${signals.join(", ")}`,
      suggestion: "Flag for human review — may contradict existing content",
    };
  }

  // Check for supersession
  if (detectSupersession(newContent, best.content, best.score)) {
    return {
      classification: "supersedes",
      confidence: best.score,
      matched_doc: {
        path: best.path,
        title: best.title ?? best.path,
        content: best.content,
        similarity: best.score,
      },
      reason: `Appears to be an updated version of ${best.path}`,
      suggestion: "Update existing document instead of creating new",
    };
  }

  // Unique — related docs exist but content is distinct
  return {
    classification: "unique",
    confidence: 0.8,
    reason: "Related documents exist but content is sufficiently distinct",
    suggestion: "Write as new document",
  };
}

// Batch classification for multiple captures

export async function classifyBatch(
  items: { id: string; content: string }[],
  qmd: QmdClient,
  config?: DedupConfig,
): Promise<Map<string, DedupResult>> {
  const results = new Map<string, DedupResult>();
  for (const item of items) {
    results.set(item.id, await classifyCapture(item.content, qmd, config));
  }
  return results;
}

// Build human-readable summary of dedup results

export function buildDedupSummary(results: Map<string, DedupResult>): string {
  const counts: Record<DedupClassification, number> = {
    unique: 0,
    duplicate: 0,
    semantic_duplicate: 0,
    conflict: 0,
    supersedes: 0,
  };

  for (const r of results.values()) {
    counts[r.classification]++;
  }

  const parts: string[] = [];
  if (counts.unique > 0) parts.push(`${counts.unique} unique`);
  if (counts.duplicate > 0) parts.push(`${counts.duplicate} duplicate${counts.duplicate > 1 ? "s" : ""}`);
  if (counts.semantic_duplicate > 0) parts.push(`${counts.semantic_duplicate} semantic duplicate${counts.semantic_duplicate > 1 ? "s" : ""}`);
  if (counts.conflict > 0) parts.push(`${counts.conflict} conflict${counts.conflict > 1 ? "s" : ""}`);
  if (counts.supersedes > 0) parts.push(`${counts.supersedes} superseding`);

  return `Dedup check: ${parts.join(", ")} (${results.size} total)`;
}
