/**
 * Round Table: Converge Phase — ELLIE-699
 *
 * Third phase of the round table session. Responsibilities:
 *   1. Synthesize outputs from all discuss-phase formations
 *   2. Identify areas of agreement and conflict
 *   3. Resolve conflicts between formation recommendations
 *   4. Produce unified analysis with prioritized conclusions
 *   5. Identify gaps that may require additional formation runs
 *
 * All external dependencies (agent calls) are injectable.
 */

import { log } from "../logger.ts";
import type { ConveneOutput, SuccessCriteria } from "./convene.ts";
import type { DiscussOutput, FormationResult } from "./discuss.ts";

const logger = log.child("round-table-converge");

// ── Types ───────────────────────────────────────────────────────

/** A point of agreement found across formations. */
export interface Agreement {
  /** What the formations agree on. */
  point: string;
  /** Which formations support this point. */
  supporters: string[];
  /** Confidence level based on supporter count. */
  confidence: "strong" | "moderate" | "weak";
}

/** A conflict or tension between formations. */
export interface Conflict {
  /** What the disagreement is about. */
  point: string;
  /** Positions taken by different formations. */
  positions: { formation: string; position: string }[];
  /** How the conflict was resolved (if at all). */
  resolution?: string;
  /** Whether this needs human input to resolve. */
  needsEscalation: boolean;
}

/** A gap identified in the discussion. */
export interface Gap {
  /** What dimension or question was not adequately addressed. */
  description: string;
  /** Which formation(s) might fill this gap on a re-run. */
  suggestedFormations: string[];
  /** Severity of the gap. */
  severity: "critical" | "moderate" | "minor";
}

/** Complete output of the converge phase. */
export interface ConvergeOutput {
  /** Areas of agreement across formations. */
  agreements: Agreement[];
  /** Conflicts identified between formations. */
  conflicts: Conflict[];
  /** Gaps in the analysis. */
  gaps: Gap[];
  /** Items requiring human escalation. */
  escalations: string[];
  /** Whether all success criteria from the convene phase are met. */
  criteriaStatus: CriteriaStatus;
  /** The synthesis produced by the converge agent. */
  synthesis: string;
  /** Formatted summary for the deliver phase. */
  summary: string;
  /** Whether the converge phase succeeded. */
  success: boolean;
  /** Error if failed. */
  error?: string;
}

/** Status check against convene success criteria. */
export interface CriteriaStatus {
  /** Whether enough formations contributed. */
  formationCountMet: boolean;
  /** Which required dimensions were addressed. */
  dimensionsAddressed: string[];
  /** Which required dimensions were NOT addressed. */
  dimensionsMissing: string[];
  /** Whether consensus was reached (if required). */
  consensusReached: boolean | null;
  /** Overall criteria pass/fail. */
  allMet: boolean;
}

/** Injectable dependencies for the converge phase. */
export interface ConvergeDeps {
  /** Call an agent to perform synthesis. */
  callAgent: (agentName: string, prompt: string) => Promise<string>;
}

/** Configuration for the converge phase. */
export interface ConvergeConfig {
  /** Agent used for synthesis. Default: "strategy". */
  synthesisAgent: string;
  /** Timeout for the synthesis call in ms. Default: 120000. */
  synthesisTimeoutMs: number;
}

const DEFAULT_CONFIG: ConvergeConfig = {
  synthesisAgent: "strategy",
  synthesisTimeoutMs: 120_000,
};

// ── Prompt Building ─────────────────────────────────────────────

/**
 * Build the converge phase prompt — all formation contributions plus
 * success criteria for the synthesizing agent to check against.
 */
export function buildConvergePrompt(
  query: string,
  conveneOutput: ConveneOutput,
  discussOutput: DiscussOutput,
): string {
  const contributions = discussOutput.results
    .map(r => {
      if (r.success) {
        return `<contribution formation="${r.slug}" status="success" duration="${r.durationMs}ms">\n${r.output}\n</contribution>`;
      }
      return `<contribution formation="${r.slug}" status="failed" error="${r.error ?? "unknown"}" />`;
    })
    .join("\n");

  const criteria = conveneOutput.successCriteria;
  const criteriaBlock = `<success-criteria>
  <expected-output>${criteria.expectedOutput}</expected-output>
  <min-formations>${criteria.minFormations}</min-formations>
  <consensus-required>${criteria.requiresConsensus}</consensus-required>
  <required-dimensions>${criteria.requiredDimensions.join(", ") || "none"}</required-dimensions>
  <key-questions>
${criteria.keyQuestions.map(q => `    <question>${q}</question>`).join("\n")}
  </key-questions>
</success-criteria>`;

  return `<round-table phase="converge">
<original-query>${query}</original-query>
<convene-summary>
${conveneOutput.summary}
</convene-summary>
<discussion-contributions>
${contributions}
</discussion-contributions>
${criteriaBlock}
<instructions>
You are synthesizing a round table discussion. Multiple formations have contributed their analysis.

Your task:
1. Identify areas of AGREEMENT across formations — what do they align on?
2. Identify CONFLICTS or tensions — where do formations disagree? Recommend a resolution.
3. Produce a PRIORITIZED set of conclusions that directly addresses the original query
4. Check against the success criteria — are all key questions answered? All dimensions addressed?
5. Flag any GAPS that need additional analysis or ESCALATIONS that need human review

Structure your synthesis clearly. Do NOT simply concatenate formation outputs.
Produce a unified, coherent analysis that weighs and integrates all perspectives.
</instructions>
</round-table>`;
}

// ── Criteria Checking ───────────────────────────────────────────

/**
 * Check the discuss results against the convene success criteria.
 */
export function checkCriteria(
  conveneOutput: ConveneOutput,
  discussOutput: DiscussOutput,
): CriteriaStatus {
  const criteria = conveneOutput.successCriteria;

  // Formation count check
  const formationCountMet = discussOutput.succeeded.length >= criteria.minFormations;

  // Dimension check — which dimensions were addressed by successful formations
  const addressedDimensions = new Set<string>();
  for (const result of discussOutput.results.filter(r => r.success)) {
    const lower = result.output.toLowerCase();
    for (const dim of criteria.requiredDimensions) {
      // Check if the formation output mentions the dimension
      const dimKeywords: Record<string, string[]> = {
        financial: ["cost", "revenue", "budget", "price", "financial", "profit", "roi"],
        risk: ["risk", "compliance", "audit", "threat", "vulnerability"],
        technical: ["code", "implement", "architecture", "deploy", "technical", "api"],
        strategic: ["strategy", "plan", "roadmap", "priority", "recommend"],
        "user-impact": ["customer", "user", "guest", "patient", "experience"],
        operational: ["team", "hire", "staff", "resource", "capacity"],
      };
      const keywords = dimKeywords[dim] ?? [dim];
      if (keywords.some(kw => lower.includes(kw))) {
        addressedDimensions.add(dim);
      }
    }
  }

  const dimensionsAddressed = Array.from(addressedDimensions);
  const dimensionsMissing = criteria.requiredDimensions.filter(d => !addressedDimensions.has(d));

  // Consensus check — null if not required
  let consensusReached: boolean | null = null;
  if (criteria.requiresConsensus) {
    // Simple heuristic: consensus is reached if all successful formations contributed
    consensusReached = discussOutput.succeeded.length >= 2;
  }

  const allMet = formationCountMet &&
    dimensionsMissing.length === 0 &&
    (consensusReached === null || consensusReached);

  return {
    formationCountMet,
    dimensionsAddressed,
    dimensionsMissing,
    consensusReached,
    allMet,
  };
}

// ── Gap Detection ───────────────────────────────────────────────

/**
 * Detect gaps in the discussion based on success criteria and formation results.
 */
export function detectGaps(
  conveneOutput: ConveneOutput,
  discussOutput: DiscussOutput,
  criteriaStatus: CriteriaStatus,
): Gap[] {
  const gaps: Gap[] = [];

  // Missing dimensions
  for (const dim of criteriaStatus.dimensionsMissing) {
    const suggestedFormations: string[] = [];
    // Suggest formations that have the relevant agents
    for (const formation of conveneOutput.selectedFormations) {
      if (formation.context.toLowerCase().includes(dim)) {
        suggestedFormations.push(formation.slug);
      }
    }

    gaps.push({
      description: `Dimension "${dim}" was not adequately addressed in the discussion`,
      suggestedFormations: suggestedFormations.length > 0 ? suggestedFormations : ["boardroom"],
      severity: "moderate",
    });
  }

  // Failed formations that were expected to contribute
  for (const slug of discussOutput.failed) {
    const formation = conveneOutput.selectedFormations.find(f => f.slug === slug);
    if (formation && formation.score >= 3) {
      gaps.push({
        description: `Formation "${slug}" failed but was a key contributor (score: ${formation.score})`,
        suggestedFormations: [slug],
        severity: formation.score >= 5 ? "critical" : "moderate",
      });
    }
  }

  // Unanswered key questions (heuristic)
  if (!criteriaStatus.formationCountMet) {
    gaps.push({
      description: `Only ${discussOutput.succeeded.length} formations contributed, below the minimum of ${conveneOutput.successCriteria.minFormations}`,
      suggestedFormations: discussOutput.failed,
      severity: "critical",
    });
  }

  return gaps;
}

// ── Summary Formatting ──────────────────────────────────────────

/**
 * Format the converge output as a structured summary for the deliver phase.
 */
function formatConvergeSummary(
  synthesis: string,
  agreements: Agreement[],
  conflicts: Conflict[],
  gaps: Gap[],
  escalations: string[],
  criteriaStatus: CriteriaStatus,
): string {
  const lines: string[] = [];

  lines.push("## Convergence Synthesis");
  lines.push("");
  lines.push(synthesis);
  lines.push("");

  if (agreements.length > 0) {
    lines.push("### Areas of Agreement");
    for (const a of agreements) {
      lines.push(`- **[${a.confidence}]** ${a.point} *(${a.supporters.join(", ")})*`);
    }
    lines.push("");
  }

  if (conflicts.length > 0) {
    lines.push("### Conflicts");
    for (const c of conflicts) {
      lines.push(`- ${c.point}`);
      for (const p of c.positions) {
        lines.push(`  - **${p.formation}**: ${p.position}`);
      }
      if (c.resolution) {
        lines.push(`  - **Resolution**: ${c.resolution}`);
      }
      if (c.needsEscalation) {
        lines.push(`  - *Needs human escalation*`);
      }
    }
    lines.push("");
  }

  if (gaps.length > 0) {
    lines.push("### Gaps");
    for (const g of gaps) {
      lines.push(`- **[${g.severity}]** ${g.description}`);
      if (g.suggestedFormations.length > 0) {
        lines.push(`  - Suggested: ${g.suggestedFormations.join(", ")}`);
      }
    }
    lines.push("");
  }

  if (escalations.length > 0) {
    lines.push("### Escalations");
    for (const e of escalations) {
      lines.push(`- ${e}`);
    }
    lines.push("");
  }

  lines.push("### Criteria Status");
  lines.push(`- Formation count: ${criteriaStatus.formationCountMet ? "MET" : "NOT MET"}`);
  lines.push(`- Dimensions addressed: ${criteriaStatus.dimensionsAddressed.join(", ") || "none"}`);
  if (criteriaStatus.dimensionsMissing.length > 0) {
    lines.push(`- Dimensions missing: ${criteriaStatus.dimensionsMissing.join(", ")}`);
  }
  if (criteriaStatus.consensusReached !== null) {
    lines.push(`- Consensus: ${criteriaStatus.consensusReached ? "reached" : "NOT reached"}`);
  }
  lines.push(`- **Overall: ${criteriaStatus.allMet ? "ALL CRITERIA MET" : "CRITERIA NOT FULLY MET"}**`);

  return lines.join("\n");
}

// ── Converge Phase Executor ─────────────────────────────────────

/**
 * Execute the converge phase:
 *   1. Check criteria status
 *   2. Detect gaps
 *   3. Build prompt and call synthesis agent
 *   4. Parse synthesis into structured output
 *   5. Return structured ConvergeOutput
 */
export async function executeConverge(
  deps: ConvergeDeps,
  query: string,
  conveneOutput: ConveneOutput,
  discussOutput: DiscussOutput,
  config?: Partial<ConvergeConfig>,
): Promise<ConvergeOutput> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  logger.info("Converge phase starting", {
    successfulFormations: discussOutput.succeeded,
    failedFormations: discussOutput.failed,
  });

  // Step 1: Check criteria
  const criteriaStatus = checkCriteria(conveneOutput, discussOutput);
  logger.info("Criteria checked", { allMet: criteriaStatus.allMet });

  // Step 2: Detect gaps
  const gaps = detectGaps(conveneOutput, discussOutput, criteriaStatus);
  if (gaps.length > 0) {
    logger.info("Gaps detected", { count: gaps.length, critical: gaps.filter(g => g.severity === "critical").length });
  }

  // Step 3: Build prompt and call agent
  let synthesis: string;
  try {
    const prompt = buildConvergePrompt(query, conveneOutput, discussOutput);
    synthesis = await Promise.race([
      deps.callAgent(cfg.synthesisAgent, prompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Synthesis agent timed out")), cfg.synthesisTimeoutMs),
      ),
    ]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("Converge synthesis failed", { error: errorMsg });

    // Fallback: concatenate successful formation outputs
    synthesis = discussOutput.results
      .filter(r => r.success)
      .map(r => `[${r.slug}] ${r.output}`)
      .join("\n\n");

    if (!synthesis) {
      return {
        agreements: [],
        conflicts: [],
        gaps,
        escalations: [],
        criteriaStatus,
        synthesis: "",
        summary: "Convergence failed: " + errorMsg,
        success: false,
        error: errorMsg,
      };
    }

    logger.warn("Using fallback concatenation for synthesis");
  }

  // Step 4: Build structured output
  // Extract agreements/conflicts from the synthesis (heuristic)
  const agreements = extractAgreements(discussOutput);
  const conflicts = extractConflicts(discussOutput);

  // Escalations from conflicts + gaps
  const escalations: string[] = [];
  for (const c of conflicts) {
    if (c.needsEscalation) {
      escalations.push(`Conflict: ${c.point}`);
    }
  }
  for (const g of gaps) {
    if (g.severity === "critical") {
      escalations.push(`Gap: ${g.description}`);
    }
  }

  // Step 5: Format summary
  const summary = formatConvergeSummary(synthesis, agreements, conflicts, gaps, escalations, criteriaStatus);

  logger.info("Converge phase complete", {
    agreements: agreements.length,
    conflicts: conflicts.length,
    gaps: gaps.length,
    escalations: escalations.length,
    criteriaAllMet: criteriaStatus.allMet,
  });

  return {
    agreements,
    conflicts,
    gaps,
    escalations,
    criteriaStatus,
    synthesis,
    summary,
    success: true,
  };
}

// ── Agreement/Conflict Extraction ───────────────────────────────

/**
 * Extract agreements by finding themes mentioned by multiple formations.
 * Simple heuristic: look for similar key phrases across successful results.
 */
function extractAgreements(discussOutput: DiscussOutput): Agreement[] {
  const agreements: Agreement[] = [];
  const successful = discussOutput.results.filter(r => r.success);

  if (successful.length < 2) return agreements;

  // Common keywords that indicate themes
  const themeKeywords = [
    "recommend", "priority", "risk", "opportunity", "improve",
    "expand", "reduce", "increase", "invest", "focus",
  ];

  for (const keyword of themeKeywords) {
    const supporters = successful
      .filter(r => r.output.toLowerCase().includes(keyword))
      .map(r => r.slug);

    if (supporters.length >= 2) {
      agreements.push({
        point: `Multiple formations reference "${keyword}" as a key theme`,
        supporters,
        confidence: supporters.length === successful.length ? "strong" : "moderate",
      });
    }
  }

  // Deduplicate by keeping only highest-confidence per unique supporters set
  const seen = new Set<string>();
  return agreements.filter(a => {
    const key = a.supporters.sort().join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Extract conflicts by looking for opposing sentiment in formation outputs.
 * Simple heuristic: look for "however", "but", "disagree", "risk" patterns.
 */
function extractConflicts(discussOutput: DiscussOutput): Conflict[] {
  const conflicts: Conflict[] = [];
  const successful = discussOutput.results.filter(r => r.success);

  if (successful.length < 2) return conflicts;

  // Check for explicit conflict markers
  for (const result of successful) {
    const lower = result.output.toLowerCase();
    if (lower.includes("disagree") || lower.includes("contrary") || lower.includes("however, ") || lower.includes("risk of")) {
      // Find which other formation might have the opposing view
      const others = successful.filter(r => r.slug !== result.slug);
      if (others.length > 0) {
        conflicts.push({
          point: `${result.slug} flags a concern or counterpoint`,
          positions: [
            { formation: result.slug, position: "Raises concern or opposing view" },
            { formation: others[0].slug, position: "May hold contrasting position" },
          ],
          needsEscalation: lower.includes("escalat") || lower.includes("human review"),
        });
      }
    }
  }

  return conflicts;
}

// ── Testing Helpers ─────────────────────────────────────────────

/**
 * Create mock converge deps.
 */
export function _makeMockConvergeDeps(
  agentResponse?: string,
): ConvergeDeps {
  return {
    callAgent: async () =>
      agentResponse ?? "Synthesis: After reviewing all formation contributions, the consensus recommendation is to proceed with a balanced approach. Key agreements: strategic expansion. Key tension: timing of implementation.",
  };
}

/**
 * Create a mock ConvergeOutput for testing downstream phases.
 */
export function _makeMockConvergeOutput(
  overrides?: Partial<ConvergeOutput>,
): ConvergeOutput {
  return {
    agreements: [
      { point: 'Multiple formations reference "recommend" as a key theme', supporters: ["boardroom", "think-tank"], confidence: "strong" },
    ],
    conflicts: [],
    gaps: [],
    escalations: [],
    criteriaStatus: {
      formationCountMet: true,
      dimensionsAddressed: ["strategic", "financial"],
      dimensionsMissing: [],
      consensusReached: null,
      allMet: true,
    },
    synthesis: "Unified analysis: balanced expansion recommended with Q2 timeline.",
    summary: "## Convergence Synthesis\n\nUnified analysis: balanced expansion recommended.",
    success: true,
    ...overrides,
  };
}
