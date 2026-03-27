/**
 * Quality Scoring Framework — ELLIE-1073
 * Structured, quantitative code review scoring for Brian (critic).
 * 7 dimensions scored 0-4, severity taxonomy P0-P3, quality gate.
 * Inspired by Impeccable's Nielsen heuristics + severity taxonomy.
 */

import { log } from "./logger.ts";

const logger = log.child("quality:scoring");

// ── Scoring Dimensions ──────────────────────────────────────

export const REVIEW_DIMENSIONS = [
  {
    id: "correctness",
    name: "Correctness",
    description: "Does the code do what it's supposed to? Logic errors, edge cases, off-by-one.",
    weight: 1.5,  // Higher weight — most important
  },
  {
    id: "security",
    name: "Security",
    description: "Input validation, injection prevention, auth checks, secret handling.",
    weight: 1.5,
  },
  {
    id: "maintainability",
    name: "Maintainability",
    description: "Readability, naming, structure, complexity, DRY, single responsibility.",
    weight: 1.0,
  },
  {
    id: "test_coverage",
    name: "Test Coverage",
    description: "Are critical paths tested? Edge cases? Error paths? Regression risk?",
    weight: 1.0,
  },
  {
    id: "performance",
    name: "Performance",
    description: "O(n) vs O(n²), unnecessary allocations, N+1 queries, memory leaks.",
    weight: 0.8,
  },
  {
    id: "error_handling",
    name: "Error Handling",
    description: "Graceful degradation, error messages, recovery paths, logging.",
    weight: 0.8,
  },
  {
    id: "architecture",
    name: "Architecture",
    description: "Fits the system, doesn't introduce coupling, follows existing patterns.",
    weight: 0.7,
  },
] as const;

export type DimensionId = typeof REVIEW_DIMENSIONS[number]["id"];

// ── Scoring Rubric ──────────────────────────────────────────

export const SCORE_RUBRIC: Record<number, string> = {
  0: "Missing — not addressed at all",
  1: "Poor — significant issues, needs rework",
  2: "Adequate — functional but has notable gaps",
  3: "Good — solid implementation, minor improvements possible",
  4: "Excellent — exemplary, no issues found",
};

// ── Severity Taxonomy ───────────────────────────────────────

export type Severity = "P0" | "P1" | "P2" | "P3";

export const SEVERITY_DEFINITIONS: Record<Severity, { name: string; description: string; action: string }> = {
  P0: { name: "Blocking", description: "Security vulnerability, data loss, crash in production", action: "Must fix before merge" },
  P1: { name: "Major", description: "Broken feature, significant edge case, architectural flaw", action: "Fix before next release" },
  P2: { name: "Minor", description: "Code quality issue, moderate edge case, inconsistency", action: "Track for follow-up" },
  P3: { name: "Polish", description: "Style, naming, minor optimization, rare edge case", action: "Optional improvement" },
};

// ── Types ───────────────────────────────────────────────────

export interface DimensionScore {
  dimension: DimensionId;
  score: number;  // 0-4
  notes: string;  // Brief explanation
}

export interface Finding {
  severity: Severity;
  title: string;
  description: string;
  file?: string;
  line?: number;
  suggestion?: string;
}

export interface QualityReview {
  reviewId: string;
  workItemId?: string;
  agent: string;  // "brian"
  target: string;  // What was reviewed (file, PR, commit)
  dimensions: DimensionScore[];
  findings: Finding[];
  totalScore: number;
  maxScore: number;
  weightedScore: number;
  maxWeightedScore: number;
  percentage: number;
  verdict: "pass" | "fail" | "conditional";
  summary: string;
  reviewedAt: string;
}

// ── Quality Gate ────────────────────────────────────────────

export interface QualityGateConfig {
  minPercentage: number;      // Overall score threshold (default 60%)
  blockOnP0: boolean;         // Any P0 = fail (default true)
  maxP1Count: number;         // Max P1s before fail (default 3)
  minDimensionScore: number;  // No dimension below this (default 1)
}

const DEFAULT_GATE: QualityGateConfig = {
  minPercentage: 60,
  blockOnP0: true,
  maxP1Count: 3,
  minDimensionScore: 1,
};

// ── Core Functions ──────────────────────────────────────────

/**
 * Calculate total and weighted scores from dimension scores.
 */
export function calculateScores(dimensions: DimensionScore[]): {
  totalScore: number;
  maxScore: number;
  weightedScore: number;
  maxWeightedScore: number;
  percentage: number;
} {
  let totalScore = 0;
  let maxScore = 0;
  let weightedScore = 0;
  let maxWeightedScore = 0;

  for (const ds of dimensions) {
    const dim = REVIEW_DIMENSIONS.find(d => d.id === ds.dimension);
    const weight = dim?.weight ?? 1.0;

    totalScore += ds.score;
    maxScore += 4;
    weightedScore += ds.score * weight;
    maxWeightedScore += 4 * weight;
  }

  const percentage = maxWeightedScore > 0
    ? Math.round((weightedScore / maxWeightedScore) * 100)
    : 0;

  return { totalScore, maxScore, weightedScore: Math.round(weightedScore * 100) / 100, maxWeightedScore: Math.round(maxWeightedScore * 100) / 100, percentage };
}

/**
 * Apply quality gate rules to determine verdict.
 */
export function applyGate(
  review: { dimensions: DimensionScore[]; findings: Finding[]; percentage: number },
  config?: Partial<QualityGateConfig>
): { verdict: "pass" | "fail" | "conditional"; reasons: string[] } {
  const gate = { ...DEFAULT_GATE, ...config };
  const reasons: string[] = [];

  // Check P0 findings
  if (gate.blockOnP0) {
    const p0Count = review.findings.filter(f => f.severity === "P0").length;
    if (p0Count > 0) {
      reasons.push(`${p0Count} P0 (blocking) finding(s)`);
    }
  }

  // Check P1 count
  const p1Count = review.findings.filter(f => f.severity === "P1").length;
  if (p1Count > gate.maxP1Count) {
    reasons.push(`${p1Count} P1 findings exceed limit of ${gate.maxP1Count}`);
  }

  // Check overall percentage
  if (review.percentage < gate.minPercentage) {
    reasons.push(`Score ${review.percentage}% below ${gate.minPercentage}% threshold`);
  }

  // Check minimum dimension scores
  for (const ds of review.dimensions) {
    if (ds.score < gate.minDimensionScore) {
      const dim = REVIEW_DIMENSIONS.find(d => d.id === ds.dimension);
      reasons.push(`${dim?.name ?? ds.dimension} scored ${ds.score}/4 (min: ${gate.minDimensionScore})`);
    }
  }

  if (reasons.length === 0) return { verdict: "pass", reasons: [] };

  // P0 or percentage failure = hard fail; P1 excess = conditional
  const hasP0 = review.findings.some(f => f.severity === "P0");
  const belowThreshold = review.percentage < gate.minPercentage;
  const verdict = hasP0 || belowThreshold ? "fail" : "conditional";

  return { verdict, reasons };
}

/**
 * Build a complete quality review.
 */
export function buildReview(opts: {
  workItemId?: string;
  target: string;
  dimensions: DimensionScore[];
  findings: Finding[];
  gateConfig?: Partial<QualityGateConfig>;
}): QualityReview {
  const scores = calculateScores(opts.dimensions);
  const gate = applyGate(
    { dimensions: opts.dimensions, findings: opts.findings, percentage: scores.percentage },
    opts.gateConfig
  );

  // Generate summary
  const p0 = opts.findings.filter(f => f.severity === "P0").length;
  const p1 = opts.findings.filter(f => f.severity === "P1").length;
  const p2 = opts.findings.filter(f => f.severity === "P2").length;
  const p3 = opts.findings.filter(f => f.severity === "P3").length;

  const summaryParts: string[] = [];
  summaryParts.push(`Score: ${scores.percentage}% (${scores.totalScore}/${scores.maxScore})`);
  summaryParts.push(`Verdict: ${gate.verdict.toUpperCase()}`);
  if (p0) summaryParts.push(`${p0} P0 blocking`);
  if (p1) summaryParts.push(`${p1} P1 major`);
  if (p2) summaryParts.push(`${p2} P2 minor`);
  if (p3) summaryParts.push(`${p3} P3 polish`);
  if (gate.reasons.length > 0) summaryParts.push(`Gate: ${gate.reasons.join("; ")}`);

  return {
    reviewId: `review_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    workItemId: opts.workItemId,
    agent: "brian",
    target: opts.target,
    dimensions: opts.dimensions,
    findings: opts.findings,
    ...scores,
    verdict: gate.verdict,
    summary: summaryParts.join(" | "),
    reviewedAt: new Date().toISOString(),
  };
}

/**
 * Format a review as markdown for prompt injection or display.
 */
export function formatReviewMarkdown(review: QualityReview): string {
  const lines: string[] = [];

  lines.push(`## Quality Review: ${review.target}`);
  lines.push("");
  lines.push(`**Score:** ${review.percentage}% (${review.totalScore}/${review.maxScore}) | **Verdict:** ${review.verdict.toUpperCase()}`);
  if (review.workItemId) lines.push(`**Work Item:** ${review.workItemId}`);
  lines.push("");

  // Dimension scores
  lines.push("### Dimension Scores");
  lines.push("| Dimension | Score | Notes |");
  lines.push("|-----------|-------|-------|");
  for (const ds of review.dimensions) {
    const dim = REVIEW_DIMENSIONS.find(d => d.id === ds.dimension);
    const bar = "\u2588".repeat(ds.score) + "\u2591".repeat(4 - ds.score);
    lines.push(`| ${dim?.name ?? ds.dimension} | ${bar} ${ds.score}/4 | ${ds.notes} |`);
  }
  lines.push("");

  // Findings by severity
  if (review.findings.length > 0) {
    lines.push("### Findings");
    for (const sev of ["P0", "P1", "P2", "P3"] as Severity[]) {
      const sevFindings = review.findings.filter(f => f.severity === sev);
      if (sevFindings.length === 0) continue;
      const def = SEVERITY_DEFINITIONS[sev];
      lines.push(`\n**${sev} — ${def.name}** (${def.action})`);
      for (const f of sevFindings) {
        const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
        lines.push(`- **${f.title}**${loc}: ${f.description}`);
        if (f.suggestion) lines.push(`  → Suggestion: ${f.suggestion}`);
      }
    }
  } else {
    lines.push("### No findings — clean review");
  }

  return lines.join("\n");
}

/**
 * Generate the scoring prompt section for Brian's context.
 * This teaches Brian how to produce structured reviews.
 */
export function getReviewPromptSection(): string {
  const dimensionList = REVIEW_DIMENSIONS.map(d =>
    `- **${d.name}** (weight ${d.weight}x): ${d.description}`
  ).join("\n");

  const rubric = Object.entries(SCORE_RUBRIC).map(([score, desc]) =>
    `  ${score}: ${desc}`
  ).join("\n");

  const severities = Object.entries(SEVERITY_DEFINITIONS).map(([sev, def]) =>
    `- **${sev} (${def.name})**: ${def.description} → ${def.action}`
  ).join("\n");

  return `## Quality Scoring Framework

When reviewing code, produce a structured quality assessment:

### Score each dimension (0-4):
${dimensionList}

### Scoring rubric:
${rubric}

### Classify findings by severity:
${severities}

### Quality gate:
- Overall score >= 60% to pass
- Any P0 finding = automatic fail
- More than 3 P1 findings = conditional (needs discussion)
- No dimension below 1/4

### Output format:
Provide your review as a JSON object:
\`\`\`json
{
  "dimensions": [
    {"dimension": "correctness", "score": 3, "notes": "Logic is sound, one edge case missed"},
    ...
  ],
  "findings": [
    {"severity": "P1", "title": "Missing null check", "description": "...", "file": "src/foo.ts", "line": 42, "suggestion": "Add null guard"}
  ]
}
\`\`\``;
}
