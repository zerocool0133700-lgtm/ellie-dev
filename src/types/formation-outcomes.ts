/**
 * Formation Outcome Typing — ELLIE-696
 *
 * Typed outcomes for each formation, enabling formation chaining.
 * When a formation completes, its output is parsed into a typed outcome
 * and persisted to formation_sessions.outcome (JSONB). A subsequent
 * formation can receive a prior formation's outcome as structured context.
 *
 * Pure module — types, parsing, validation, and chaining helpers only.
 */

// ── Base Outcome ────────────────────────────────────────────────

/** Every outcome has these fields. */
export interface BaseOutcome {
  /** Which formation produced this outcome. */
  formationName: string;
  /** ISO timestamp when the outcome was produced. */
  completedAt: string;
  /** The original query/prompt that initiated the formation. */
  query: string;
  /** Overall success indicator. */
  success: boolean;
  /** High-level summary of the outcome. */
  summary: string;
}

// ── Think Tank Outcome ──────────────────────────────────────────

export interface ThinkTankOutcome extends BaseOutcome {
  formationName: "think-tank";
  /** Ideas generated during the session. */
  ideas: { title: string; description: string; champion: string }[];
  /** Key themes that emerged. */
  themes: string[];
  /** Recommended next steps. */
  nextSteps: string[];
}

// ── Boardroom Outcome ───────────────────────────────────────────

export interface BoardroomOutcome extends BaseOutcome {
  formationName: "boardroom";
  /** Strategic recommendations, prioritized. */
  recommendations: {
    priority: "P0" | "P1" | "P2";
    title: string;
    rationale: string;
    owner?: string;
  }[];
  /** Risks identified. */
  risks: { description: string; severity: "high" | "medium" | "low"; mitigation?: string }[];
  /** Decisions made. */
  decisions: { decision: string; reasoning: string }[];
  /** Items requiring escalation/human review. */
  escalations: string[];
}

// ── VRBO Ops Outcome ────────────────────────────────────────────

export interface VrboOpsOutcome extends BaseOutcome {
  formationName: "vrbo-ops";
  /** Property performance metrics. */
  metrics: {
    occupancyRate?: number;
    averageDailyRate?: number;
    revenuePerAvailable?: number;
    guestSatisfaction?: number;
  };
  /** Action items for property operations. */
  actionItems: { action: string; priority: "P0" | "P1" | "P2"; assignee?: string }[];
  /** Guest experience issues flagged. */
  guestIssues: string[];
  /** Maintenance items identified. */
  maintenance: string[];
}

// ── Software Development Outcome ────────────────────────────────

export interface SoftwareDevOutcome extends BaseOutcome {
  formationName: "software-development";
  /** Technical approach chosen. */
  approach: string;
  /** Files that were or should be changed. */
  filesChanged: string[];
  /** Technical decisions with reasoning. */
  technicalDecisions: { decision: string; reasoning: string; alternatives?: string[] }[];
  /** Test results or test plan. */
  testStatus: { passed: number; failed: number; skipped: number } | null;
  /** Issues or blockers identified. */
  blockers: string[];
}

// ── Billing Ops Outcome ─────────────────────────────────────────

export interface BillingOpsOutcome extends BaseOutcome {
  formationName: "billing-ops";
  /** Dashboard action items, prioritized. */
  dashboard: { priority: "P0" | "P1" | "P2"; item: string; assignee?: string; value?: string }[];
  /** Compliance audit results. */
  complianceStatus: "approved" | "approved-with-flags" | "flagged";
  /** Compliance flags requiring attention. */
  complianceFlags: string[];
  /** Escalation items for human review. */
  escalations: string[];
  /** Revenue metrics. */
  revenueMetrics: {
    totalDenials?: string;
    recoverable?: string;
    collectionRate?: number;
    denialRate?: number;
  };
}

// ── Union Type ──────────────────────────────────────────────────

/** All possible formation outcomes. */
export type FormationOutcome =
  | ThinkTankOutcome
  | BoardroomOutcome
  | VrboOpsOutcome
  | SoftwareDevOutcome
  | BillingOpsOutcome;

/** Map from formation name to its outcome type. */
export type FormationOutcomeMap = {
  "think-tank": ThinkTankOutcome;
  "boardroom": BoardroomOutcome;
  "vrbo-ops": VrboOpsOutcome;
  "software-development": SoftwareDevOutcome;
  "billing-ops": BillingOpsOutcome;
};

/** Formation names that have typed outcomes. */
export const TYPED_FORMATION_NAMES = [
  "think-tank",
  "boardroom",
  "vrbo-ops",
  "software-development",
  "billing-ops",
] as const;

export type TypedFormationName = typeof TYPED_FORMATION_NAMES[number];

/** Check if a formation name has a typed outcome. */
export function isTypedFormation(name: string): name is TypedFormationName {
  return (TYPED_FORMATION_NAMES as readonly string[]).includes(name);
}

// ── Outcome Parsing ─────────────────────────────────────────────

/**
 * Parse a raw JSONB outcome from the database into a typed outcome.
 * Returns null if the data doesn't match any known formation type
 * or is missing required base fields.
 */
export function parseOutcome(raw: unknown): FormationOutcome | null {
  if (!raw || typeof raw !== "object") return null;

  const obj = raw as Record<string, unknown>;

  // Validate base fields
  if (typeof obj.formationName !== "string") return null;
  if (typeof obj.summary !== "string") return null;
  if (typeof obj.success !== "boolean") return null;

  if (!isTypedFormation(obj.formationName)) return null;

  return raw as FormationOutcome;
}

/**
 * Parse and validate an outcome for a specific formation type.
 * Returns null if the outcome doesn't match the expected formation.
 */
export function parseOutcomeAs<K extends TypedFormationName>(
  raw: unknown,
  formationName: K,
): FormationOutcomeMap[K] | null {
  const outcome = parseOutcome(raw);
  if (!outcome) return null;
  if (outcome.formationName !== formationName) return null;
  return outcome as FormationOutcomeMap[K];
}

// ── Outcome Validation ──────────────────────────────────────────

export interface OutcomeValidationError {
  field: string;
  message: string;
}

/**
 * Validate that an outcome has all required base fields.
 */
export function validateOutcome(outcome: unknown): {
  valid: boolean;
  errors: OutcomeValidationError[];
} {
  const errors: OutcomeValidationError[] = [];

  if (!outcome || typeof outcome !== "object") {
    errors.push({ field: "outcome", message: "Outcome must be an object" });
    return { valid: false, errors };
  }

  const obj = outcome as Record<string, unknown>;

  if (typeof obj.formationName !== "string" || !obj.formationName) {
    errors.push({ field: "formationName", message: "formationName is required" });
  }
  if (typeof obj.completedAt !== "string" || !obj.completedAt) {
    errors.push({ field: "completedAt", message: "completedAt is required" });
  }
  if (typeof obj.query !== "string") {
    errors.push({ field: "query", message: "query is required" });
  }
  if (typeof obj.success !== "boolean") {
    errors.push({ field: "success", message: "success must be a boolean" });
  }
  if (typeof obj.summary !== "string" || !obj.summary) {
    errors.push({ field: "summary", message: "summary is required" });
  }

  // Formation-specific validation
  if (typeof obj.formationName === "string" && isTypedFormation(obj.formationName)) {
    validateFormationSpecific(obj, errors);
  }

  return { valid: errors.length === 0, errors };
}

function validateFormationSpecific(
  obj: Record<string, unknown>,
  errors: OutcomeValidationError[],
): void {
  switch (obj.formationName) {
    case "think-tank":
      if (!Array.isArray(obj.ideas)) {
        errors.push({ field: "ideas", message: "think-tank outcome requires ideas array" });
      }
      if (!Array.isArray(obj.themes)) {
        errors.push({ field: "themes", message: "think-tank outcome requires themes array" });
      }
      break;
    case "boardroom":
      if (!Array.isArray(obj.recommendations)) {
        errors.push({ field: "recommendations", message: "boardroom outcome requires recommendations array" });
      }
      if (!Array.isArray(obj.decisions)) {
        errors.push({ field: "decisions", message: "boardroom outcome requires decisions array" });
      }
      break;
    case "vrbo-ops":
      if (!Array.isArray(obj.actionItems)) {
        errors.push({ field: "actionItems", message: "vrbo-ops outcome requires actionItems array" });
      }
      break;
    case "software-development":
      if (typeof obj.approach !== "string") {
        errors.push({ field: "approach", message: "software-development outcome requires approach string" });
      }
      if (!Array.isArray(obj.filesChanged)) {
        errors.push({ field: "filesChanged", message: "software-development outcome requires filesChanged array" });
      }
      break;
    case "billing-ops":
      if (!Array.isArray(obj.dashboard)) {
        errors.push({ field: "dashboard", message: "billing-ops outcome requires dashboard array" });
      }
      if (typeof obj.complianceStatus !== "string") {
        errors.push({ field: "complianceStatus", message: "billing-ops outcome requires complianceStatus" });
      }
      break;
  }
}

// ── Formation Chaining ──────────────────────────────────────────

/**
 * Context passed to a formation when it receives a prior formation's outcome.
 */
export interface ChainContext {
  /** The prior formation's name. */
  priorFormation: string;
  /** The prior formation's typed outcome. */
  priorOutcome: FormationOutcome;
  /** How the current formation should use the prior outcome. */
  chainInstructions: string;
}

/**
 * Build chain context from a prior outcome for injection into a formation prompt.
 * Returns an XML-structured block that can be included in the formation prompt.
 */
export function buildChainContextPrompt(chain: ChainContext): string {
  const lines: string[] = [];

  lines.push(`<prior-formation name="${chain.priorFormation}">`);
  lines.push(`<summary>${chain.priorOutcome.summary}</summary>`);
  lines.push(`<success>${chain.priorOutcome.success}</success>`);

  // Include formation-specific highlights
  const highlights = extractOutcomeHighlights(chain.priorOutcome);
  if (highlights.length > 0) {
    lines.push(`<key-findings>`);
    for (const h of highlights) {
      lines.push(`  <finding>${h}</finding>`);
    }
    lines.push(`</key-findings>`);
  }

  lines.push(`<chain-instructions>${chain.chainInstructions}</chain-instructions>`);
  lines.push(`</prior-formation>`);

  return lines.join("\n");
}

/**
 * Extract key highlights from a typed outcome for inclusion in chain context.
 */
export function extractOutcomeHighlights(outcome: FormationOutcome): string[] {
  const highlights: string[] = [];

  switch (outcome.formationName) {
    case "think-tank":
      for (const idea of outcome.ideas.slice(0, 5)) {
        highlights.push(`Idea: ${idea.title} — ${idea.description}`);
      }
      for (const theme of outcome.themes.slice(0, 3)) {
        highlights.push(`Theme: ${theme}`);
      }
      break;

    case "boardroom":
      for (const rec of outcome.recommendations.filter(r => r.priority === "P0")) {
        highlights.push(`[${rec.priority}] ${rec.title}: ${rec.rationale}`);
      }
      for (const dec of outcome.decisions.slice(0, 3)) {
        highlights.push(`Decision: ${dec.decision}`);
      }
      for (const esc of outcome.escalations.slice(0, 3)) {
        highlights.push(`Escalation: ${esc}`);
      }
      break;

    case "vrbo-ops":
      if (outcome.metrics.occupancyRate !== undefined) {
        highlights.push(`Occupancy: ${outcome.metrics.occupancyRate}%`);
      }
      for (const item of outcome.actionItems.filter(a => a.priority === "P0")) {
        highlights.push(`[${item.priority}] ${item.action}`);
      }
      break;

    case "software-development":
      highlights.push(`Approach: ${outcome.approach}`);
      if (outcome.testStatus) {
        highlights.push(`Tests: ${outcome.testStatus.passed} pass, ${outcome.testStatus.failed} fail`);
      }
      for (const blocker of outcome.blockers.slice(0, 3)) {
        highlights.push(`Blocker: ${blocker}`);
      }
      break;

    case "billing-ops":
      highlights.push(`Compliance: ${outcome.complianceStatus}`);
      for (const item of outcome.dashboard.filter(d => d.priority === "P0")) {
        highlights.push(`[${item.priority}] ${item.item}`);
      }
      for (const esc of outcome.escalations.slice(0, 3)) {
        highlights.push(`Escalation: ${esc}`);
      }
      break;
  }

  return highlights;
}

/**
 * Create a chain between two formations — the prior outcome becomes context for the next.
 * Returns the chain context object ready for prompt injection.
 */
export function createChain(
  priorOutcome: FormationOutcome,
  chainInstructions?: string,
): ChainContext {
  return {
    priorFormation: priorOutcome.formationName,
    priorOutcome,
    chainInstructions: chainInstructions ??
      `Use the prior formation's findings to inform your analysis. Build on their conclusions and address any gaps or escalations.`,
  };
}

// ── Outcome Persistence Helpers ─────────────────────────────────

/**
 * Prepare an outcome for storage in the JSONB column.
 * Ensures the outcome is serializable and has all base fields.
 */
export function serializeOutcome(outcome: FormationOutcome): Record<string, unknown> {
  return JSON.parse(JSON.stringify(outcome));
}

/**
 * Deserialize an outcome from the JSONB column.
 */
export function deserializeOutcome(raw: unknown): FormationOutcome | null {
  return parseOutcome(raw);
}

// ── Testing Helpers ─────────────────────────────────────────────

export function _makeMockThinkTankOutcome(
  overrides: Partial<ThinkTankOutcome> = {},
): ThinkTankOutcome {
  return {
    formationName: "think-tank",
    completedAt: new Date().toISOString(),
    query: "Generate ideas for Q2",
    success: true,
    summary: "Generated 3 ideas across 2 themes",
    ideas: [
      { title: "Expand vertically", description: "Go deeper in current market", champion: "strategy" },
      { title: "New market entry", description: "Enter adjacent vertical", champion: "research" },
    ],
    themes: ["growth", "diversification"],
    nextSteps: ["Validate market size", "Run competitive analysis"],
    ...overrides,
  };
}

export function _makeMockBoardroomOutcome(
  overrides: Partial<BoardroomOutcome> = {},
): BoardroomOutcome {
  return {
    formationName: "boardroom",
    completedAt: new Date().toISOString(),
    query: "Q2 strategy review",
    success: true,
    summary: "Approved hybrid expansion strategy",
    recommendations: [
      { priority: "P0", title: "Deepen current vertical", rationale: "Highest ROI opportunity", owner: "product" },
      { priority: "P1", title: "Pilot new market", rationale: "Growth potential", owner: "strategy" },
    ],
    risks: [
      { description: "Competitor launching Q3", severity: "high", mitigation: "Accelerate feature release" },
    ],
    decisions: [
      { decision: "Adopt hybrid approach", reasoning: "Balances growth with risk" },
    ],
    escalations: ["Board approval needed for new market budget"],
    ...overrides,
  };
}

export function _makeMockVrboOpsOutcome(
  overrides: Partial<VrboOpsOutcome> = {},
): VrboOpsOutcome {
  return {
    formationName: "vrbo-ops",
    completedAt: new Date().toISOString(),
    query: "Monthly property review",
    success: true,
    summary: "All properties performing within targets",
    metrics: { occupancyRate: 78, averageDailyRate: 185, guestSatisfaction: 4.6 },
    actionItems: [
      { action: "Reprice Beach House for spring season", priority: "P0" },
    ],
    guestIssues: ["WiFi complaints at Mountain Cabin"],
    maintenance: ["HVAC service due at Beach House"],
    ...overrides,
  };
}

export function _makeMockSoftwareDevOutcome(
  overrides: Partial<SoftwareDevOutcome> = {},
): SoftwareDevOutcome {
  return {
    formationName: "software-development",
    completedAt: new Date().toISOString(),
    query: "Implement user auth",
    success: true,
    summary: "Auth system implemented with JWT tokens",
    approach: "JWT + refresh tokens with httpOnly cookies",
    filesChanged: ["src/auth.ts", "src/middleware.ts", "tests/auth.test.ts"],
    technicalDecisions: [
      { decision: "Use httpOnly cookies", reasoning: "More secure than localStorage", alternatives: ["localStorage", "sessionStorage"] },
    ],
    testStatus: { passed: 12, failed: 0, skipped: 1 },
    blockers: [],
    ...overrides,
  };
}

export function _makeMockBillingOpsOutcome(
  overrides: Partial<BillingOpsOutcome> = {},
): BillingOpsOutcome {
  return {
    formationName: "billing-ops",
    completedAt: new Date().toISOString(),
    query: "Weekly billing review",
    success: true,
    summary: "12.3% denial rate, $209K recoverable",
    dashboard: [
      { priority: "P0", item: "Fix ERA posting errors", value: "$28K" },
      { priority: "P0", item: "Resubmit CO-4 denials", value: "$18K" },
    ],
    complianceStatus: "approved-with-flags",
    complianceFlags: ["Batch 2024-0312 needs manual review"],
    escalations: ["Client approval needed for $41K write-off"],
    revenueMetrics: {
      totalDenials: "$312K",
      recoverable: "$209K",
      collectionRate: 94.2,
      denialRate: 12.3,
    },
    ...overrides,
  };
}
