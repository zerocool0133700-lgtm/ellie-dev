/**
 * Round Table: Convene Phase — ELLIE-697
 *
 * First phase of the round table session. Responsibilities:
 *   1. Analyze the incoming query to extract intent, domain, and complexity
 *   2. Select which formations should participate in the discuss phase
 *   3. Prepare per-formation context (tailored prompts for each)
 *   4. Define success criteria for the session
 *
 * All external dependencies (agent calls, formation catalog) are injectable.
 */

import { log } from "../logger.ts";
import {
  TYPED_FORMATION_NAMES,
  type TypedFormationName,
} from "../types/formation-outcomes.ts";

const logger = log.child("round-table-convene");

// ── Formation Registry ──────────────────────────────────────────

/** Metadata about a formation, used for matching queries to formations. */
export interface FormationEntry {
  slug: string;
  description: string;
  triggers: string[];
  agents: string[];
  pattern: string;
}

/** The 5 built-in formations with their metadata. */
export const FORMATION_REGISTRY: FormationEntry[] = [
  {
    slug: "think-tank",
    description: "Brainstorming and ideation — generate ideas, explore themes, identify opportunities",
    triggers: ["brainstorm", "ideas", "think tank", "ideation", "creative", "explore", "opportunity", "innovation"],
    agents: ["researcher", "strategist", "critic", "creative"],
    pattern: "debate",
  },
  {
    slug: "boardroom",
    description: "Strategic decision-making — evaluate options, make recommendations, assess risks",
    triggers: ["strategy", "decision", "boardroom", "evaluate", "recommendation", "risk", "planning", "roadmap", "priority"],
    agents: ["finance", "strategy", "research", "critic"],
    pattern: "coordinator",
  },
  {
    slug: "vrbo-ops",
    description: "Vacation rental operations — property performance, guest experience, maintenance, pricing",
    triggers: ["vrbo", "property", "rental", "airbnb", "guest", "occupancy", "pricing", "maintenance", "booking", "vacation rental"],
    agents: ["finance", "ops", "research", "strategy", "critic"],
    pattern: "pipeline",
  },
  {
    slug: "software-development",
    description: "Software engineering — architecture, implementation, code review, testing, deployment",
    triggers: ["code", "software", "development", "implementation", "bug", "feature", "architecture", "deploy", "test", "refactor", "engineering"],
    agents: ["dev", "architect", "reviewer", "tester"],
    pattern: "pipeline",
  },
  {
    slug: "billing-ops",
    description: "Medical billing operations — claims, denials, compliance, revenue cycle, Office Practicum",
    triggers: ["billing", "claims", "denial", "medical billing", "revenue cycle", "compliance", "office practicum", "A/R", "payer", "coding"],
    agents: ["finance", "research", "billing", "strategy", "critic"],
    pattern: "pipeline",
  },
];

// ── Query Analysis ──────────────────────────────────────────────

/** Result of analyzing a query for the convene phase. */
export interface QueryAnalysis {
  /** The original query. */
  query: string;
  /** Extracted intent (what the user wants to accomplish). */
  intent: string;
  /** Primary domain(s) the query relates to. */
  domains: string[];
  /** Estimated complexity: simple (1 formation), moderate (2), complex (3+). */
  complexity: "simple" | "moderate" | "complex";
  /** Key dimensions or aspects that need to be addressed. */
  dimensions: string[];
  /** Keywords extracted from the query. */
  keywords: string[];
}

/**
 * Analyze a query to extract intent, domain, complexity, and dimensions.
 * Uses keyword matching against the formation registry.
 * For richer analysis, the orchestrator can also call an agent to refine this.
 */
export function analyzeQuery(query: string): QueryAnalysis {
  const lower = query.toLowerCase();
  const words = lower.split(/\s+/).map(w => w.replace(/[^a-z0-9/-]/g, "")).filter(w => w.length > 2);

  // Extract keywords (non-stopword tokens)
  const stopwords = new Set([
    "the", "and", "for", "are", "but", "not", "you", "all", "can", "her",
    "was", "one", "our", "out", "has", "had", "how", "its", "let", "may",
    "who", "did", "get", "use", "say", "she", "his", "him", "that", "this",
    "with", "have", "from", "they", "been", "will", "what", "when", "make",
    "like", "just", "over", "such", "than", "them", "very", "some", "into",
    "most", "only", "come", "could", "now", "look", "also", "back", "much",
    "should", "would", "about", "which", "their", "where", "there", "these",
    "those", "then", "each", "other", "being", "does", "doing", "please",
  ]);
  const keywords = words.filter(w => !stopwords.has(w) && w.length > 2);

  // Detect which domains match
  const domainScores = new Map<string, number>();
  for (const formation of FORMATION_REGISTRY) {
    let score = 0;
    for (const trigger of formation.triggers) {
      if (lower.includes(trigger)) {
        score += trigger.includes(" ") ? 3 : 1; // multi-word triggers score higher
      }
    }
    if (score > 0) {
      domainScores.set(formation.slug, score);
    }
  }

  // Sort domains by score
  const domains = Array.from(domainScores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([slug]) => slug);

  // Estimate complexity
  let complexity: QueryAnalysis["complexity"] = "simple";
  if (domains.length >= 3 || keywords.length >= 8) {
    complexity = "complex";
  } else if (domains.length >= 2 || keywords.length >= 5) {
    complexity = "moderate";
  }

  // Extract dimensions based on common question patterns
  const dimensions: string[] = [];
  if (lower.includes("cost") || lower.includes("price") || lower.includes("revenue") || lower.includes("budget")) {
    dimensions.push("financial");
  }
  if (lower.includes("risk") || lower.includes("compliance") || lower.includes("audit")) {
    dimensions.push("risk");
  }
  if (lower.includes("implement") || lower.includes("build") || lower.includes("code") || lower.includes("deploy")) {
    dimensions.push("technical");
  }
  if (lower.includes("strategy") || lower.includes("plan") || lower.includes("roadmap") || lower.includes("prioritize")) {
    dimensions.push("strategic");
  }
  if (lower.includes("customer") || lower.includes("guest") || lower.includes("user") || lower.includes("patient")) {
    dimensions.push("user-impact");
  }
  if (lower.includes("team") || lower.includes("hire") || lower.includes("staff") || lower.includes("resource")) {
    dimensions.push("operational");
  }

  // Infer intent — ordered by specificity (most specific first, use else-if)
  let intent = "General analysis";
  if (lower.includes("decide") || lower.includes("choose") || lower.includes("should we")) {
    intent = "Make a decision";
  } else if (lower.includes("plan") || lower.includes("strategy") || lower.includes("roadmap")) {
    intent = "Create a plan";
  } else if (lower.includes("review") || lower.includes("audit") || lower.includes("analyze")) {
    intent = "Review and analyze";
  } else if (lower.includes("implement") || lower.includes("build") || lower.includes("deploy")) {
    intent = "Implementation guidance";
  } else if (lower.includes("?") || lower.startsWith("what") || lower.startsWith("how") || lower.startsWith("why")) {
    intent = "Answer a question";
  }

  return {
    query,
    intent,
    domains,
    complexity,
    dimensions,
    keywords,
  };
}

// ── Formation Selection ─────────────────────────────────────────

/** A formation selected for the discuss phase, with context. */
export interface SelectedFormation {
  slug: string;
  /** Why this formation was selected. */
  reason: string;
  /** Custom context to include in this formation's prompt. */
  context: string;
  /** The match score (higher = more relevant). */
  score: number;
}

/**
 * Select formations to participate in the discuss phase based on query analysis.
 * Returns formations sorted by relevance score.
 */
export function selectFormations(
  analysis: QueryAnalysis,
  opts?: {
    /** Maximum number of formations to select. Default: 3. */
    maxFormations?: number;
    /** Minimum score threshold to include. Default: 1. */
    minScore?: number;
    /** Force-include these formations regardless of score. */
    forceInclude?: string[];
  },
): SelectedFormation[] {
  const maxFormations = opts?.maxFormations ?? 3;
  const minScore = opts?.minScore ?? 1;
  const forceInclude = new Set(opts?.forceInclude ?? []);

  const scored: SelectedFormation[] = [];

  for (const formation of FORMATION_REGISTRY) {
    let score = 0;
    const reasons: string[] = [];

    // Domain match from query analysis
    const domainIndex = analysis.domains.indexOf(formation.slug);
    if (domainIndex >= 0) {
      const domainScore = (analysis.domains.length - domainIndex) * 2;
      score += domainScore;
      reasons.push(`Domain match (rank ${domainIndex + 1})`);
    }

    // Keyword overlap with triggers
    const triggerMatches = formation.triggers.filter(t =>
      analysis.keywords.some(k => t.includes(k) || k.includes(t)),
    );
    if (triggerMatches.length > 0) {
      score += triggerMatches.length;
      reasons.push(`Trigger matches: ${triggerMatches.join(", ")}`);
    }

    // Dimension alignment
    if (analysis.dimensions.includes("financial") && formation.agents.includes("finance")) {
      score += 1;
      reasons.push("Has finance perspective");
    }
    if (analysis.dimensions.includes("risk") && formation.agents.includes("critic")) {
      score += 1;
      reasons.push("Has critic/risk perspective");
    }
    if (analysis.dimensions.includes("technical") && formation.agents.includes("dev")) {
      score += 1;
      reasons.push("Has technical perspective");
    }
    if (analysis.dimensions.includes("strategic") && formation.agents.includes("strategy")) {
      score += 1;
      reasons.push("Has strategic perspective");
    }

    // Force-include
    if (forceInclude.has(formation.slug)) {
      score = Math.max(score, minScore);
      reasons.push("Force-included");
    }

    if (score >= minScore || forceInclude.has(formation.slug)) {
      scored.push({
        slug: formation.slug,
        reason: reasons.join("; "),
        context: buildFormationContext(formation, analysis),
        score,
      });
    }
  }

  // Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxFormations);
}

/**
 * Build per-formation context based on the query analysis.
 * This tells each formation what aspect to focus on.
 */
function buildFormationContext(formation: FormationEntry, analysis: QueryAnalysis): string {
  const lines: string[] = [];

  lines.push(`Focus area: ${formation.description}`);

  if (analysis.dimensions.length > 0) {
    const relevant = analysis.dimensions.filter(d => {
      if (d === "financial" && formation.agents.includes("finance")) return true;
      if (d === "risk" && formation.agents.includes("critic")) return true;
      if (d === "technical" && formation.agents.includes("dev")) return true;
      if (d === "strategic" && formation.agents.includes("strategy")) return true;
      return false;
    });
    if (relevant.length > 0) {
      lines.push(`Relevant dimensions: ${relevant.join(", ")}`);
    }
  }

  lines.push(`Query intent: ${analysis.intent}`);

  return lines.join("\n");
}

// ── Success Criteria ────────────────────────────────────────────

/** Success criteria for a round table session. */
export interface SuccessCriteria {
  /** What the session should produce (e.g., "decision", "plan", "analysis"). */
  expectedOutput: string;
  /** Key questions that must be answered. */
  keyQuestions: string[];
  /** Minimum number of formations that must contribute. */
  minFormations: number;
  /** Whether consensus is required across formations. */
  requiresConsensus: boolean;
  /** Dimensions that must be addressed. */
  requiredDimensions: string[];
}

/**
 * Define success criteria for a round table session based on query analysis
 * and selected formations.
 */
export function defineSuccessCriteria(
  analysis: QueryAnalysis,
  selectedFormations: SelectedFormation[],
): SuccessCriteria {
  // Determine expected output type
  let expectedOutput: string;
  switch (analysis.intent) {
    case "Make a decision":
      expectedOutput = "A clear decision with reasoning and next steps";
      break;
    case "Create a plan":
      expectedOutput = "A structured plan with priorities, timelines, and owners";
      break;
    case "Implementation guidance":
      expectedOutput = "Technical approach with specific recommendations";
      break;
    case "Review and analyze":
      expectedOutput = "Comprehensive analysis with findings and recommendations";
      break;
    default:
      expectedOutput = "A thorough answer addressing all key dimensions";
  }

  // Build key questions from dimensions
  const keyQuestions: string[] = [];
  for (const dim of analysis.dimensions) {
    switch (dim) {
      case "financial":
        keyQuestions.push("What are the financial implications?");
        break;
      case "risk":
        keyQuestions.push("What are the key risks and mitigations?");
        break;
      case "technical":
        keyQuestions.push("What is the technical approach?");
        break;
      case "strategic":
        keyQuestions.push("What is the strategic recommendation?");
        break;
      case "user-impact":
        keyQuestions.push("How will this affect users/customers?");
        break;
      case "operational":
        keyQuestions.push("What are the operational requirements?");
        break;
    }
  }
  if (keyQuestions.length === 0) {
    keyQuestions.push("Does the output directly address the original query?");
  }

  // Consensus requirements
  const requiresConsensus = analysis.intent === "Make a decision" || analysis.complexity === "complex";

  return {
    expectedOutput,
    keyQuestions,
    minFormations: Math.min(selectedFormations.length, analysis.complexity === "simple" ? 1 : 2),
    requiresConsensus,
    requiredDimensions: analysis.dimensions,
  };
}

// ── Convene Phase Output ────────────────────────────────────────

/** Complete output of the convene phase. */
export interface ConveneOutput {
  /** Raw query analysis. */
  analysis: QueryAnalysis;
  /** Formations selected for the discuss phase. */
  selectedFormations: SelectedFormation[];
  /** Success criteria for the session. */
  successCriteria: SuccessCriteria;
  /** Formatted summary for the next phase. */
  summary: string;
}

/**
 * Build the convene prompt for the agent — enhanced version that includes
 * the formation registry so the agent can reason about which formations to use.
 */
export function buildEnhancedConvenePrompt(
  query: string,
  analysis: QueryAnalysis,
): string {
  const formationList = FORMATION_REGISTRY.map(f =>
    `  - ${f.slug}: ${f.description} (agents: ${f.agents.join(", ")}; pattern: ${f.pattern})`,
  ).join("\n");

  return `<round-table phase="convene">
<query>${query}</query>
<preliminary-analysis>
  <intent>${analysis.intent}</intent>
  <domains>${analysis.domains.join(", ") || "none detected"}</domains>
  <complexity>${analysis.complexity}</complexity>
  <dimensions>${analysis.dimensions.join(", ") || "none detected"}</dimensions>
  <keywords>${analysis.keywords.join(", ")}</keywords>
</preliminary-analysis>
<available-formations>
${formationList}
</available-formations>
<instructions>
You are convening a round table session. Based on the preliminary analysis above:

1. Refine the problem statement — what exactly needs to be answered or decided?
2. Confirm or adjust the key dimensions that need addressing
3. Recommend which formations should participate and why
4. Define what a successful outcome looks like

Your output will guide the formation selection and discussion phase.
Be concise and structured.
</instructions>
</round-table>`;
}

/**
 * Format the convene output as a summary string for the next phase.
 */
function formatConveneSummary(
  analysis: QueryAnalysis,
  selectedFormations: SelectedFormation[],
  successCriteria: SuccessCriteria,
  agentRefinement?: string,
): string {
  const lines: string[] = [];

  lines.push("## Convene Phase Summary");
  lines.push("");
  lines.push(`**Intent:** ${analysis.intent}`);
  lines.push(`**Complexity:** ${analysis.complexity}`);
  lines.push(`**Dimensions:** ${analysis.dimensions.join(", ") || "general"}`);
  lines.push("");
  lines.push("### Selected Formations");
  for (const f of selectedFormations) {
    lines.push(`- **${f.slug}** (score: ${f.score}) — ${f.reason}`);
  }
  lines.push("");
  lines.push("### Success Criteria");
  lines.push(`- Expected output: ${successCriteria.expectedOutput}`);
  lines.push(`- Consensus required: ${successCriteria.requiresConsensus ? "yes" : "no"}`);
  lines.push(`- Key questions:`);
  for (const q of successCriteria.keyQuestions) {
    lines.push(`  - ${q}`);
  }

  if (agentRefinement) {
    lines.push("");
    lines.push("### Agent Refinement");
    lines.push(agentRefinement);
  }

  return lines.join("\n");
}

// ── Convene Phase Executor ──────────────────────────────────────

/** Injectable dependencies for the convene phase. */
export interface ConveneDeps {
  /** Call an agent for query refinement. */
  callAgent: (agentName: string, prompt: string) => Promise<string>;
}

/** Options for the convene phase. */
export interface ConveneOpts {
  /** Agent to use for refinement. Default: "strategy". */
  conveneAgent?: string;
  /** Maximum formations to select. Default: 3. */
  maxFormations?: number;
  /** Force-include these formations. */
  forceFormations?: string[];
  /** Skip agent refinement (use only keyword analysis). */
  skipAgentRefinement?: boolean;
}

/**
 * Execute the convene phase:
 *   1. Analyze the query (keyword-based)
 *   2. Select formations
 *   3. Optionally refine with an agent call
 *   4. Define success criteria
 *   5. Return structured ConveneOutput
 */
export async function executeConvene(
  deps: ConveneDeps,
  query: string,
  opts?: ConveneOpts,
): Promise<ConveneOutput> {
  const conveneAgent = opts?.conveneAgent ?? "strategy";

  logger.info("Convene phase starting", { query: query.slice(0, 100) });

  // Step 1: Analyze
  const analysis = analyzeQuery(query);
  logger.info("Query analyzed", {
    intent: analysis.intent,
    domains: analysis.domains,
    complexity: analysis.complexity,
  });

  // Step 2: Select formations
  const selectedFormations = selectFormations(analysis, {
    maxFormations: opts?.maxFormations,
    forceInclude: opts?.forceFormations,
  });
  logger.info("Formations selected", {
    formations: selectedFormations.map(f => f.slug),
  });

  // Step 3: Optionally refine with agent
  let agentRefinement: string | undefined;
  if (!opts?.skipAgentRefinement) {
    try {
      const prompt = buildEnhancedConvenePrompt(query, analysis);
      agentRefinement = await deps.callAgent(conveneAgent, prompt);
    } catch (err) {
      logger.warn("Agent refinement failed, proceeding with keyword analysis", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Step 4: Define success criteria
  const successCriteria = defineSuccessCriteria(analysis, selectedFormations);

  // Step 5: Format summary
  const summary = formatConveneSummary(analysis, selectedFormations, successCriteria, agentRefinement);

  logger.info("Convene phase complete", {
    formations: selectedFormations.map(f => f.slug),
    complexity: analysis.complexity,
    dimensions: analysis.dimensions,
  });

  return {
    analysis,
    selectedFormations,
    successCriteria,
    summary,
  };
}

// ── Testing Helpers ─────────────────────────────────────────────

/**
 * Create mock convene deps.
 */
export function _makeMockConveneDeps(
  agentResponse?: string,
): ConveneDeps {
  return {
    callAgent: async (_agent: string, _prompt: string) =>
      agentResponse ?? "Agent refinement: The query requires strategic and financial analysis. Recommend boardroom and billing-ops formations.",
  };
}

/**
 * Create a mock ConveneOutput for testing downstream phases.
 */
export function _makeMockConveneOutput(
  overrides?: Partial<ConveneOutput>,
): ConveneOutput {
  return {
    analysis: {
      query: "What should our Q2 strategy be?",
      intent: "Create a plan",
      domains: ["boardroom", "think-tank"],
      complexity: "moderate",
      dimensions: ["strategic", "financial"],
      keywords: ["strategy", "plan", "growth"],
    },
    selectedFormations: [
      {
        slug: "boardroom",
        reason: "Domain match (rank 1); Has strategic perspective",
        context: "Focus area: Strategic decision-making\nRelevant dimensions: strategic, financial\nQuery intent: Create a plan",
        score: 6,
      },
      {
        slug: "think-tank",
        reason: "Domain match (rank 2)",
        context: "Focus area: Brainstorming and ideation\nQuery intent: Create a plan",
        score: 4,
      },
    ],
    successCriteria: {
      expectedOutput: "A structured plan with priorities, timelines, and owners",
      keyQuestions: [
        "What is the strategic recommendation?",
        "What are the financial implications?",
      ],
      minFormations: 2,
      requiresConsensus: false,
      requiredDimensions: ["strategic", "financial"],
    },
    summary: "## Convene Phase Summary\n\n**Intent:** Create a plan\n**Complexity:** moderate",
    ...overrides,
  };
}
