/**
 * Round Table: Discuss Phase — ELLIE-698
 *
 * Second phase of the round table session. Responsibilities:
 *   1. Execute selected formations in parallel
 *   2. Enforce per-formation timeouts
 *   3. Handle failures gracefully (partial results are OK)
 *   4. Collect typed formation outcomes
 *   5. Produce a structured discuss output for the converge phase
 *
 * All external dependencies (formation invocation) are injectable.
 */

import { log } from "../logger.ts";
import type { ConveneOutput, SelectedFormation } from "./convene.ts";

const logger = log.child("round-table-discuss");

// ── Types ───────────────────────────────────────────────────────

/** Result of invoking a single formation in the discuss phase. */
export interface FormationResult {
  slug: string;
  /** Whether the formation completed successfully. */
  success: boolean;
  /** The formation's output/synthesis. */
  output: string;
  /** Error message if the formation failed. */
  error?: string;
  /** How long the formation took in ms. */
  durationMs: number;
  /** Whether the formation was timed out. */
  timedOut: boolean;
}

/** Complete output of the discuss phase. */
export interface DiscussOutput {
  /** Per-formation results. */
  results: FormationResult[];
  /** Formations that succeeded. */
  succeeded: string[];
  /** Formations that failed. */
  failed: string[];
  /** Overall success — true if at least one formation succeeded. */
  success: boolean;
  /** Formatted summary for the converge phase. */
  summary: string;
  /** Total duration in ms. */
  totalDurationMs: number;
}

/** Injectable function that invokes a formation and returns its output. */
export type FormationInvokeFn = (
  slug: string,
  prompt: string,
  opts?: { channel?: string; workItemId?: string },
) => Promise<{ success: boolean; synthesis: string; error?: string }>;

/** Injectable dependencies for the discuss phase. */
export interface DiscussDeps {
  invokeFormation: FormationInvokeFn;
}

/** Configuration for the discuss phase. */
export interface DiscussConfig {
  /** Timeout per formation in ms. Default: 600000 (10 min). */
  formationTimeoutMs: number;
  /** Maximum concurrent formations. Default: 5. */
  maxConcurrent: number;
  /** Minimum formations that must succeed for the phase to pass. Default: 1. */
  minSuccessful: number;
}

const DEFAULT_CONFIG: DiscussConfig = {
  formationTimeoutMs: 600_000,
  maxConcurrent: 5,
  minSuccessful: 1,
};

// ── Prompt Building ─────────────────────────────────────────────

/**
 * Build the prompt for a specific formation in the discuss phase.
 * Includes the original query, convene analysis, and per-formation context.
 */
export function buildDiscussFormationPrompt(
  query: string,
  conveneOutput: ConveneOutput,
  formation: SelectedFormation,
): string {
  return `<round-table phase="discuss">
<original-query>${query}</original-query>
<convene-analysis>
${conveneOutput.summary}
</convene-analysis>
<formation slug="${formation.slug}" score="${formation.score}">
<selection-reason>${formation.reason}</selection-reason>
<context>
${formation.context}
</context>
</formation>
<instructions>
You are the "${formation.slug}" formation contributing to a round table discussion.

The convene phase has analyzed the query and selected your formation to contribute
your domain expertise. Your selection reason: ${formation.reason}

Provide thorough analysis from your domain perspective:
- Focus on substance — specific data, concrete recommendations, clear reasoning
- Address the key dimensions identified in the convene analysis
- Flag any risks, concerns, or items needing escalation
- Be concise but comprehensive

Your output will be combined with other formations' contributions in the converge phase.
</instructions>
</round-table>`;
}

// ── Formation Execution ─────────────────────────────────────────

/**
 * Invoke a single formation with timeout enforcement.
 */
async function invokeWithTimeout(
  deps: DiscussDeps,
  slug: string,
  prompt: string,
  timeoutMs: number,
  opts?: { channel?: string; workItemId?: string },
): Promise<FormationResult> {
  const start = Date.now();

  try {
    const result = await Promise.race([
      deps.invokeFormation(slug, prompt, opts),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Formation "${slug}" timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);

    const durationMs = Date.now() - start;

    if (result.success) {
      logger.info("Formation completed", { slug, durationMs });
      return {
        slug,
        success: true,
        output: result.synthesis,
        durationMs,
        timedOut: false,
      };
    } else {
      logger.warn("Formation returned failure", { slug, error: result.error });
      return {
        slug,
        success: false,
        output: "",
        error: result.error ?? "Formation returned failure",
        durationMs,
        timedOut: false,
      };
    }
  } catch (err) {
    const durationMs = Date.now() - start;
    const errorMsg = err instanceof Error ? err.message : String(err);
    const timedOut = errorMsg.includes("timed out");

    logger.warn("Formation failed", { slug, error: errorMsg, timedOut });

    return {
      slug,
      success: false,
      output: "",
      error: errorMsg,
      durationMs,
      timedOut,
    };
  }
}

/**
 * Execute multiple formations in parallel with concurrency control.
 */
async function executeFormationsParallel(
  deps: DiscussDeps,
  formations: { slug: string; prompt: string }[],
  config: DiscussConfig,
  opts?: { channel?: string; workItemId?: string },
): Promise<FormationResult[]> {
  const results: FormationResult[] = [];

  // Process in batches of maxConcurrent
  for (let i = 0; i < formations.length; i += config.maxConcurrent) {
    const batch = formations.slice(i, i + config.maxConcurrent);

    const batchResults = await Promise.all(
      batch.map(f =>
        invokeWithTimeout(deps, f.slug, f.prompt, config.formationTimeoutMs, opts),
      ),
    );

    results.push(...batchResults);
  }

  return results;
}

// ── Summary Formatting ──────────────────────────────────────────

/**
 * Format the discuss output as a structured summary for the converge phase.
 * Each formation's output is wrapped with metadata.
 */
function formatDiscussSummary(results: FormationResult[]): string {
  const lines: string[] = [];

  lines.push("## Discuss Phase — Formation Contributions");
  lines.push("");

  for (const result of results) {
    if (result.success) {
      lines.push(`### ${result.slug}`);
      lines.push(`*Duration: ${result.durationMs}ms*`);
      lines.push("");
      lines.push(result.output);
      lines.push("");
    } else {
      lines.push(`### ${result.slug} (FAILED)`);
      lines.push(`*Error: ${result.error}${result.timedOut ? " (timeout)" : ""}*`);
      lines.push("");
    }
  }

  const succeeded = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  lines.push("---");
  lines.push(`**Summary:** ${succeeded.length}/${results.length} formations contributed.`);
  if (failed.length > 0) {
    lines.push(`**Failed:** ${failed.map(f => f.slug).join(", ")}`);
  }

  return lines.join("\n");
}

// ── Discuss Phase Executor ──────────────────────────────────────

/**
 * Execute the discuss phase:
 *   1. Build prompts for each selected formation
 *   2. Run formations in parallel with timeouts
 *   3. Collect results and format summary
 *   4. Return structured DiscussOutput
 */
export async function executeDiscuss(
  deps: DiscussDeps,
  query: string,
  conveneOutput: ConveneOutput,
  config?: Partial<DiscussConfig>,
  opts?: { channel?: string; workItemId?: string },
): Promise<DiscussOutput> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const phaseStart = Date.now();

  logger.info("Discuss phase starting", {
    formations: conveneOutput.selectedFormations.map(f => f.slug),
    config: { formationTimeoutMs: cfg.formationTimeoutMs, maxConcurrent: cfg.maxConcurrent },
  });

  // Handle empty formation list
  if (conveneOutput.selectedFormations.length === 0) {
    logger.warn("No formations selected for discuss phase");
    return {
      results: [],
      succeeded: [],
      failed: [],
      success: false,
      summary: "No formations were selected for discussion.",
      totalDurationMs: Date.now() - phaseStart,
    };
  }

  // Build prompts for each formation
  const formationPrompts = conveneOutput.selectedFormations.map(f => ({
    slug: f.slug,
    prompt: buildDiscussFormationPrompt(query, conveneOutput, f),
  }));

  // Execute in parallel
  const results = await executeFormationsParallel(deps, formationPrompts, cfg, opts);

  const succeeded = results.filter(r => r.success).map(r => r.slug);
  const failed = results.filter(r => !r.success).map(r => r.slug);
  const totalDurationMs = Date.now() - phaseStart;

  // Phase succeeds if enough formations succeeded
  const success = succeeded.length >= cfg.minSuccessful;

  const summary = formatDiscussSummary(results);

  logger.info("Discuss phase complete", {
    succeeded,
    failed,
    totalDurationMs,
    success,
  });

  return {
    results,
    succeeded,
    failed,
    success,
    summary,
    totalDurationMs,
  };
}

// ── Testing Helpers ─────────────────────────────────────────────

/**
 * Create mock discuss deps with canned formation results.
 */
export function _makeMockDiscussDeps(
  results?: Record<string, string>,
  errorSlugs?: string[],
): DiscussDeps {
  return {
    invokeFormation: async (slug: string) => {
      if (errorSlugs?.includes(slug)) {
        return { success: false, synthesis: "", error: `Formation "${slug}" failed` };
      }
      return {
        success: true,
        synthesis: results?.[slug] ?? `[${slug}] Analysis complete.`,
      };
    },
  };
}

/**
 * Create mock discuss deps where specified formations throw (simulating crash/timeout).
 */
export function _makeMockDiscussDepsWithThrows(
  results?: Record<string, string>,
  throwSlugs?: string[],
): DiscussDeps {
  return {
    invokeFormation: async (slug: string) => {
      if (throwSlugs?.includes(slug)) {
        throw new Error(`Formation "${slug}" crashed`);
      }
      return {
        success: true,
        synthesis: results?.[slug] ?? `[${slug}] Analysis complete.`,
      };
    },
  };
}

/**
 * Create a mock slow formation invoke fn for timeout testing.
 */
export function _makeMockSlowDiscussDeps(
  delayMs: number,
  results?: Record<string, string>,
): DiscussDeps {
  return {
    invokeFormation: async (slug: string) => {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return {
        success: true,
        synthesis: results?.[slug] ?? `[${slug}] Analysis complete.`,
      };
    },
  };
}

/**
 * Create a mock DiscussOutput for testing downstream phases.
 */
export function _makeMockDiscussOutput(
  overrides?: Partial<DiscussOutput>,
): DiscussOutput {
  return {
    results: [
      { slug: "boardroom", success: true, output: "Strategic analysis: recommend expansion.", durationMs: 100, timedOut: false },
      { slug: "think-tank", success: true, output: "Ideas: three new market approaches.", durationMs: 80, timedOut: false },
    ],
    succeeded: ["boardroom", "think-tank"],
    failed: [],
    success: true,
    summary: "## Discuss Phase\n\n### boardroom\nStrategic analysis.\n\n### think-tank\nIdeas generated.",
    totalDurationMs: 120,
    ...overrides,
  };
}
