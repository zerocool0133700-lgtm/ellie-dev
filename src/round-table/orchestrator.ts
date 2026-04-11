/**
 * Round Table Orchestrator — ELLIE-695
 *
 * Main orchestration logic for running round table sessions through
 * all 4 phases: convene → discuss → converge → deliver.
 *
 * Each phase selects appropriate formations, invokes them, and threads
 * the output to the next phase as input.
 *
 * All external dependencies (formation invocation, agent calls, DB) are injectable.
 */

import { log } from "../logger.ts";
import {
  ROUND_TABLE_PHASES,
  createSession,
  startSession,
  advancePhase,
  failSession,
  timeoutSession,
  getSessionProgress,
  _makeMockDeps as _makeMockRoundTableDeps,
  _resetIdCounter,
  type RoundTableDeps,
  type RoundTableSession,
  type RoundTablePhaseType,
  type CreateRoundTableOpts,
} from "../types/round-table.ts";

const logger = log.child("round-table-orchestrator");

// ── Injectable Dependencies ─────────────────────────────────────

/**
 * Function that invokes a formation by slug and returns a result.
 * Wraps the formation orchestrator's invokeFormation().
 */
export type FormationInvokeFn = (
  slug: string,
  prompt: string,
  opts?: { channel?: string; workItemId?: string },
) => Promise<FormationInvokeResult>;

export interface FormationInvokeResult {
  success: boolean;
  synthesis: string;
  formationName: string;
  error?: string;
}

/**
 * Function that selects which formations to use for a given phase.
 * Returns formation slugs in execution order.
 */
export type FormationSelectorFn = (
  phase: RoundTablePhaseType,
  query: string,
  priorOutput: string | null,
) => Promise<string[]>;

/**
 * Function that calls an agent directly (for phases that don't use formations).
 */
export type AgentCallFn = (
  agentName: string,
  prompt: string,
  opts?: { timeoutMs?: number },
) => Promise<string>;

export interface RoundTableOrchestratorDeps {
  /** Round table session/phase stores. */
  roundTableDeps: RoundTableDeps;
  /** Invoke a formation by slug. */
  invokeFormation: FormationInvokeFn;
  /** Select formations for a phase. */
  selectFormations: FormationSelectorFn;
  /** Call an agent directly (for synthesis/delivery). */
  callAgent: AgentCallFn;
}

// ── Configuration ───────────────────────────────────────────────

export interface RoundTableConfig {
  /** Timeout per phase in ms. Default: 600000 (10 min). */
  phaseTimeoutMs: number;
  /** Timeout for the entire session in ms. Default: 900000 (15 min). */
  sessionTimeoutMs: number;
  /** Agent used for the convene phase analysis. Default: "strategy". */
  conveneAgent: string;
  /** Agent used for the deliver phase synthesis. Default: "strategy". */
  deliverAgent: string;
}

const DEFAULT_CONFIG: RoundTableConfig = {
  phaseTimeoutMs: 600_000,
  sessionTimeoutMs: 900_000,
  conveneAgent: "strategy",
  deliverAgent: "strategy",
};

// ── Result Types ────────────────────────────────────────────────

export interface RoundTableResult {
  sessionId: string;
  /** Final deliverable output. */
  output: string;
  /** Per-phase results. */
  phases: PhaseResult[];
  /** Whether the full session completed. */
  success: boolean;
  /** Error if failed. */
  error?: string;
}

export interface PhaseResult {
  phase: RoundTablePhaseType;
  output: string;
  formationsUsed: string[];
  success: boolean;
  error?: string;
}

// ── Prompt Building ─────────────────────────────────────────────

/**
 * Build the convene phase prompt — analyze the query and determine scope.
 */
export function buildConvenePrompt(query: string): string {
  return `<round-table phase="convene">
<query>${query}</query>
<instructions>
You are convening a round table session. Analyze this query and produce:
1. A clear problem statement
2. The key dimensions that need to be addressed
3. Which perspectives would be most valuable (e.g. financial, technical, strategic, critical)
4. Suggested approach — which formations or agent groups should weigh in

Be concise and structured. Your output will guide the discussion phase.
</instructions>
</round-table>`;
}

/**
 * Build the discuss phase prompt — formation-specific, includes convene output.
 */
export function buildDiscussPrompt(
  query: string,
  conveneOutput: string,
  formationSlug: string,
): string {
  return `<round-table phase="discuss">
<original-query>${query}</original-query>
<convene-analysis>${conveneOutput}</convene-analysis>
<instructions>
This is the discussion phase of a round table session. The convene phase has analyzed
the query and identified key dimensions. Your formation ("${formationSlug}") has been
selected to contribute. Provide thorough analysis from your domain perspective.

Focus on substance — specific data, concrete recommendations, and clear reasoning.
Your output will be combined with other formations' contributions in the converge phase.
</instructions>
</round-table>`;
}

/**
 * Build the converge phase prompt — synthesize all discussion outputs.
 */
export function buildConvergePrompt(
  query: string,
  conveneOutput: string,
  discussOutputs: { formation: string; output: string }[],
): string {
  const contributions = discussOutputs
    .map(d => `<contribution formation="${d.formation}">${d.output}</contribution>`)
    .join("\n");

  return `<round-table phase="converge">
<original-query>${query}</original-query>
<convene-analysis>${conveneOutput}</convene-analysis>
<discussion-contributions>
${contributions}
</discussion-contributions>
<instructions>
This is the convergence phase. Multiple formations have contributed their analysis.
Synthesize these into a coherent picture:
1. Identify areas of agreement across formations
2. Note any disagreements or tensions with reasoning
3. Produce a clear, prioritized set of conclusions
4. Flag items that need escalation or human review

Produce a structured synthesis, not a concatenation.
</instructions>
</round-table>`;
}

/**
 * Build the deliver phase prompt — produce the final deliverable.
 */
export function buildDeliverPrompt(
  query: string,
  convergeOutput: string,
): string {
  return `<round-table phase="deliver">
<original-query>${query}</original-query>
<convergence-synthesis>${convergeOutput}</convergence-synthesis>
<instructions>
This is the delivery phase. Take the convergence synthesis and produce a final,
polished deliverable that directly answers the original query.

Format for clarity:
- Lead with the key answer or recommendation
- Support with structured detail (bullet points, priorities, timelines as appropriate)
- End with next steps or action items if applicable

This is the final output the user will see.
</instructions>
</round-table>`;
}

// ── Core Orchestration ──────────────────────────────────────────

/**
 * Run a full round table session through all 4 phases.
 *
 * Flow:
 *   1. Convene — analyze the query, determine scope
 *   2. Discuss — invoke selected formations
 *   3. Converge — synthesize formation outputs
 *   4. Deliver — produce final deliverable
 */
export async function runRoundTable(
  deps: RoundTableOrchestratorDeps,
  query: string,
  opts: {
    initiatorAgent?: string;
    channel?: string;
    workItemId?: string;
    config?: Partial<RoundTableConfig>;
  } = {},
): Promise<RoundTableResult> {
  const config = { ...DEFAULT_CONFIG, ...opts.config };
  const phaseResults: PhaseResult[] = [];

  // Create and start session
  const session = createSession(deps.roundTableDeps, {
    query,
    initiator_agent: opts.initiatorAgent ?? config.conveneAgent,
    channel: opts.channel,
    work_item_id: opts.workItemId,
  });
  startSession(deps.roundTableDeps, session.id);

  logger.info("Round table started", {
    sessionId: session.id,
    query: query.slice(0, 100),
  });

  // Set up session timeout — shared deadline prevents phase overshoot
  const sessionStart = Date.now();
  const sessionDeadline = sessionStart + config.sessionTimeoutMs;

  try {
    // ── Phase 1: Convene ──────────────────────────────────────
    const conveneResult = await executeConvenePhase(deps, session, query, config, sessionDeadline);
    phaseResults.push(conveneResult);

    if (!conveneResult.success) {
      failSession(deps.roundTableDeps, session.id, conveneResult.error ?? "Convene phase failed");
      return makeResult(session.id, phaseResults, false, conveneResult.error);
    }

    checkTimeout(sessionStart, config.sessionTimeoutMs);
    advancePhase(deps.roundTableDeps, session.id, conveneResult.output, conveneResult.formationsUsed);

    // ── Phase 2: Discuss ──────────────────────────────────────
    const discussResult = await executeDiscussPhase(
      deps, session, query, conveneResult.output, config, sessionDeadline,
    );
    phaseResults.push(discussResult);

    if (!discussResult.success) {
      failSession(deps.roundTableDeps, session.id, discussResult.error ?? "Discuss phase failed");
      return makeResult(session.id, phaseResults, false, discussResult.error);
    }

    checkTimeout(sessionStart, config.sessionTimeoutMs);
    advancePhase(deps.roundTableDeps, session.id, discussResult.output, discussResult.formationsUsed);

    // ── Phase 3: Converge ─────────────────────────────────────
    const convergeResult = await executeConvergePhase(
      deps, session, query, conveneResult.output, discussResult, config, sessionDeadline,
    );
    phaseResults.push(convergeResult);

    if (!convergeResult.success) {
      failSession(deps.roundTableDeps, session.id, convergeResult.error ?? "Converge phase failed");
      return makeResult(session.id, phaseResults, false, convergeResult.error);
    }

    checkTimeout(sessionStart, config.sessionTimeoutMs);
    advancePhase(deps.roundTableDeps, session.id, convergeResult.output, convergeResult.formationsUsed);

    // ── Phase 4: Deliver ──────────────────────────────────────
    const deliverResult = await executeDeliverPhase(
      deps, session, query, convergeResult.output, config, sessionDeadline,
    );
    phaseResults.push(deliverResult);

    if (!deliverResult.success) {
      failSession(deps.roundTableDeps, session.id, deliverResult.error ?? "Deliver phase failed");
      return makeResult(session.id, phaseResults, false, deliverResult.error);
    }

    // Complete — deliver is the terminal phase, advancePhase handles session completion
    advancePhase(deps.roundTableDeps, session.id, deliverResult.output, deliverResult.formationsUsed);

    logger.info("Round table completed", { sessionId: session.id });

    return makeResult(session.id, phaseResults, true);

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    if (errorMsg === "SESSION_TIMEOUT") {
      timeoutSession(deps.roundTableDeps, session.id);
      return makeResult(session.id, phaseResults, false, "Session timed out");
    }

    failSession(deps.roundTableDeps, session.id, errorMsg);
    return makeResult(session.id, phaseResults, false, errorMsg);
  }
}

// ── Phase Executors ─────────────────────────────────────────────

/**
 * Convene phase — analyze the query using a direct agent call.
 */
async function executeConvenePhase(
  deps: RoundTableOrchestratorDeps,
  session: RoundTableSession,
  query: string,
  config: RoundTableConfig,
  sessionDeadline: number,
): Promise<PhaseResult> {
  logger.info("Executing convene phase", { sessionId: session.id });

  try {
    const prompt = buildConvenePrompt(query);
    const effectiveTimeout = cappedTimeout(config.phaseTimeoutMs, sessionDeadline);
    const output = await withTimeout(
      deps.callAgent(config.conveneAgent, prompt),
      effectiveTimeout,
      "Convene phase timed out",
    );

    return { phase: "convene", output, formationsUsed: [], success: true };
  } catch (err) {
    if (err instanceof Error && err.message === "SESSION_TIMEOUT") throw err;
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("Convene phase failed", { error: errorMsg });
    return { phase: "convene", output: "", formationsUsed: [], success: false, error: errorMsg };
  }
}

/**
 * Discuss phase — select and invoke formations based on convene output.
 */
async function executeDiscussPhase(
  deps: RoundTableOrchestratorDeps,
  session: RoundTableSession,
  query: string,
  conveneOutput: string,
  config: RoundTableConfig,
  sessionDeadline: number,
): Promise<PhaseResult & { contributions?: { formation: string; output: string }[] }> {
  logger.info("Executing discuss phase", { sessionId: session.id });

  try {
    // Select formations for this phase
    const formations = await deps.selectFormations("discuss", query, conveneOutput);

    if (formations.length === 0) {
      return {
        phase: "discuss",
        output: "No formations selected for discussion.",
        formationsUsed: [],
        success: true,
        contributions: [],
      };
    }

    logger.info("Formations selected for discuss", { formations });

    // Invoke each formation
    const contributions: { formation: string; output: string }[] = [];

    for (const slug of formations) {
      const prompt = buildDiscussPrompt(query, conveneOutput, slug);

      try {
        const effectiveTimeout = cappedTimeout(config.phaseTimeoutMs, sessionDeadline);
        const result = await withTimeout(
          deps.invokeFormation(slug, prompt, {
            channel: session.channel,
            workItemId: session.work_item_id ?? undefined,
          }),
          effectiveTimeout,
          `Formation "${slug}" timed out`,
        );

        contributions.push({
          formation: slug,
          output: result.success ? result.synthesis : `[Error: ${result.error}]`,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.warn(`Formation ${slug} failed in discuss`, { error: errorMsg });
        contributions.push({
          formation: slug,
          output: `[Error: ${errorMsg}]`,
        });
      }
    }

    // Aggregate discussion outputs
    const output = contributions
      .map(c => `### ${c.formation}\n${c.output}`)
      .join("\n\n");

    return {
      phase: "discuss",
      output,
      formationsUsed: formations,
      success: true,
      contributions,
    };
  } catch (err) {
    if (err instanceof Error && err.message === "SESSION_TIMEOUT") throw err;
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("Discuss phase failed", { error: errorMsg });
    return { phase: "discuss", output: "", formationsUsed: [], success: false, error: errorMsg };
  }
}

/**
 * Converge phase — synthesize all discussion contributions via agent call.
 */
async function executeConvergePhase(
  deps: RoundTableOrchestratorDeps,
  session: RoundTableSession,
  query: string,
  conveneOutput: string,
  discussResult: PhaseResult & { contributions?: { formation: string; output: string }[] },
  config: RoundTableConfig,
  sessionDeadline: number,
): Promise<PhaseResult> {
  logger.info("Executing converge phase", { sessionId: session.id });

  try {
    const contributions = discussResult.contributions ?? [];

    // If no contributions, pass the raw discuss output
    const prompt = contributions.length > 0
      ? buildConvergePrompt(query, conveneOutput, contributions)
      : buildConvergePrompt(query, conveneOutput, [
          { formation: "discussion", output: discussResult.output },
        ]);

    const effectiveTimeout = cappedTimeout(config.phaseTimeoutMs, sessionDeadline);
    const output = await withTimeout(
      deps.callAgent(config.deliverAgent, prompt),
      effectiveTimeout,
      "Converge phase timed out",
    );

    return {
      phase: "converge",
      output,
      formationsUsed: discussResult.formationsUsed,
      success: true,
    };
  } catch (err) {
    if (err instanceof Error && err.message === "SESSION_TIMEOUT") throw err;
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("Converge phase failed", { error: errorMsg });
    return { phase: "converge", output: "", formationsUsed: [], success: false, error: errorMsg };
  }
}

/**
 * Deliver phase — produce the final output via agent call.
 */
async function executeDeliverPhase(
  deps: RoundTableOrchestratorDeps,
  session: RoundTableSession,
  query: string,
  convergeOutput: string,
  config: RoundTableConfig,
  sessionDeadline: number,
): Promise<PhaseResult> {
  logger.info("Executing deliver phase", { sessionId: session.id });

  try {
    const prompt = buildDeliverPrompt(query, convergeOutput);
    const effectiveTimeout = cappedTimeout(config.phaseTimeoutMs, sessionDeadline);
    const output = await withTimeout(
      deps.callAgent(config.deliverAgent, prompt),
      effectiveTimeout,
      "Deliver phase timed out",
    );

    return { phase: "deliver", output, formationsUsed: [], success: true };
  } catch (err) {
    if (err instanceof Error && err.message === "SESSION_TIMEOUT") throw err;
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("Deliver phase failed", { error: errorMsg });
    return { phase: "deliver", output: "", formationsUsed: [], success: false, error: errorMsg };
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function makeResult(
  sessionId: string,
  phases: PhaseResult[],
  success: boolean,
  error?: string,
): RoundTableResult {
  const lastSuccessfulPhase = [...phases].reverse().find(p => p.success);
  return {
    sessionId,
    output: lastSuccessfulPhase?.output ?? "",
    phases,
    success,
    error,
  };
}

function checkTimeout(startTime: number, timeoutMs: number): void {
  if (Date.now() - startTime > timeoutMs) {
    throw new Error("SESSION_TIMEOUT");
  }
}

/** Cap a phase timeout to the remaining session budget, preventing overshoot. */
function cappedTimeout(phaseTimeoutMs: number, sessionDeadline: number): number {
  const remaining = sessionDeadline - Date.now();
  // Use at least 1ms — the between-phases checkTimeout() handles fully expired sessions
  return Math.max(1, Math.min(phaseTimeoutMs, remaining));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(message)), timeoutMs),
    ),
  ]);
}

// ── Testing Helpers ─────────────────────────────────────────────

/**
 * Create a mock formation invoke function that returns canned results.
 */
export function _makeMockFormationInvoke(
  results?: Record<string, string>,
): FormationInvokeFn {
  return async (slug: string, prompt: string) => ({
    success: true,
    synthesis: results?.[slug] ?? `[${slug}] Formation analysis complete.`,
    formationName: slug,
  });
}

/**
 * Create a mock formation invoke function that fails for specific formations.
 */
export function _makeMockFormationInvokeWithErrors(
  errorSlugs: string[],
  results?: Record<string, string>,
): FormationInvokeFn {
  return async (slug: string) => {
    if (errorSlugs.includes(slug)) {
      return {
        success: false,
        synthesis: "",
        formationName: slug,
        error: `Formation "${slug}" failed`,
      };
    }
    return {
      success: true,
      synthesis: results?.[slug] ?? `[${slug}] Formation analysis complete.`,
      formationName: slug,
    };
  };
}

/**
 * Create a mock formation selector that returns fixed formations per phase.
 */
export function _makeMockFormationSelector(
  phaseFormations?: Record<string, string[]>,
): FormationSelectorFn {
  return async (phase: RoundTablePhaseType) => {
    return phaseFormations?.[phase] ?? [];
  };
}

/**
 * Create a mock agent call function.
 */
export function _makeMockAgentCall(
  responses?: Record<string, string>,
): AgentCallFn {
  return async (agentName: string, prompt: string) => {
    if (responses?.[agentName]) return responses[agentName];

    // Return phase-appropriate default responses
    if (prompt.includes('phase="convene"')) {
      return "Problem analysis: The query requires multi-dimensional analysis. Key dimensions: strategic, financial, technical. Recommended formations: boardroom, research-panel.";
    }
    if (prompt.includes('phase="converge"')) {
      return "Synthesis: After reviewing all contributions, the consensus is clear. Key findings have been integrated into a coherent recommendation.";
    }
    if (prompt.includes('phase="deliver"')) {
      return "Final deliverable: Based on the round table discussion, here are the key recommendations and action items.";
    }
    return `[${agentName}] Default response.`;
  };
}

/**
 * Create complete mock orchestrator deps for testing.
 */
export function _makeMockOrchestratorDeps(opts?: {
  formationResults?: Record<string, string>;
  phaseFormations?: Record<string, string[]>;
  agentResponses?: Record<string, string>;
  errorFormations?: string[];
}): RoundTableOrchestratorDeps {
  return {
    roundTableDeps: _makeMockRoundTableDeps(),
    invokeFormation: opts?.errorFormations
      ? _makeMockFormationInvokeWithErrors(opts.errorFormations, opts.formationResults)
      : _makeMockFormationInvoke(opts?.formationResults),
    selectFormations: _makeMockFormationSelector(opts?.phaseFormations ?? {
      discuss: ["boardroom"],
    }),
    callAgent: _makeMockAgentCall(opts?.agentResponses),
  };
}

// Re-export for test convenience
export { _resetIdCounter };
