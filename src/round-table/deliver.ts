/**
 * Round Table: Deliver Phase — ELLIE-700
 *
 * Final phase of the round table session. Responsibilities:
 *   1. Format final output for the delivery channel (Telegram, Google Chat, dashboard)
 *   2. Generate concise, actionable executive summary
 *   3. Attach supporting detail (formation transcripts, data)
 *   4. Log round table session outcome
 *   5. Produce a structured DeliverOutput for session completion
 *
 * All external dependencies (agent calls, logging) are injectable.
 */

import { log } from "../logger.ts";
import type { ConveneOutput } from "./convene.ts";
import type { DiscussOutput, FormationResult } from "./discuss.ts";
import type { ConvergeOutput } from "./converge.ts";

const logger = log.child("round-table-deliver");

// ── Types ───────────────────────────────────────────────────────

/** Supported delivery channels. */
export type DeliveryChannel = "telegram" | "google-chat" | "dashboard" | "plain";

/** A formation transcript entry for the detail attachment. */
export interface FormationTranscript {
  slug: string;
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

/** Session outcome logged at the end of a round table. */
export interface SessionOutcome {
  sessionId: string;
  query: string;
  success: boolean;
  formationsUsed: string[];
  formationsSucceeded: string[];
  formationsFailed: string[];
  totalDurationMs: number;
  criteriaAllMet: boolean;
  escalationCount: number;
  gapCount: number;
  channel: DeliveryChannel;
}

/** Complete output of the deliver phase. */
export interface DeliverOutput {
  /** The formatted executive summary. */
  executiveSummary: string;
  /** Full formatted output for the delivery channel. */
  formattedOutput: string;
  /** Formation transcripts as supporting detail. */
  transcripts: FormationTranscript[];
  /** Session outcome record. */
  outcome: SessionOutcome;
  /** The delivery channel used. */
  channel: DeliveryChannel;
  /** Whether the deliver phase succeeded. */
  success: boolean;
  /** Error if failed. */
  error?: string;
}

/** Injectable dependencies for the deliver phase. */
export interface DeliverDeps {
  /** Call an agent to generate the executive summary. */
  callAgent: (agentName: string, prompt: string) => Promise<string>;
  /** Log the session outcome. */
  logOutcome: (outcome: SessionOutcome) => Promise<void>;
}

/** Configuration for the deliver phase. */
export interface DeliverConfig {
  /** Agent used for executive summary generation. Default: "strategy". */
  summaryAgent: string;
  /** Timeout for the summary agent call in ms. Default: 60000. */
  summaryTimeoutMs: number;
  /** Maximum length for executive summary in characters. Default: 2000. */
  maxSummaryLength: number;
  /** Whether to include formation transcripts. Default: true. */
  includeTranscripts: boolean;
}

const DEFAULT_CONFIG: DeliverConfig = {
  summaryAgent: "strategy",
  summaryTimeoutMs: 60_000,
  maxSummaryLength: 2000,
  includeTranscripts: true,
};

// ── Executive Summary Generation ────────────────────────────────

/**
 * Build the prompt for executive summary generation.
 */
export function buildSummaryPrompt(
  query: string,
  convergeOutput: ConvergeOutput,
): string {
  const agreementSection = convergeOutput.agreements.length > 0
    ? convergeOutput.agreements.map(a => `- ${a.point} (${a.confidence})`).join("\n")
    : "None identified";

  const conflictSection = convergeOutput.conflicts.length > 0
    ? convergeOutput.conflicts.map(c => `- ${c.point}${c.resolution ? ` → ${c.resolution}` : ""}`).join("\n")
    : "None";

  const gapSection = convergeOutput.gaps.length > 0
    ? convergeOutput.gaps.map(g => `- [${g.severity}] ${g.description}`).join("\n")
    : "None";

  const escalationSection = convergeOutput.escalations.length > 0
    ? convergeOutput.escalations.map(e => `- ${e}`).join("\n")
    : "None";

  return `<round-table phase="deliver" task="executive-summary">
<original-query>${query}</original-query>
<convergence-synthesis>
${convergeOutput.synthesis}
</convergence-synthesis>
<agreements>
${agreementSection}
</agreements>
<conflicts>
${conflictSection}
</conflicts>
<gaps>
${gapSection}
</gaps>
<escalations>
${escalationSection}
</escalations>
<criteria-met>${convergeOutput.criteriaStatus.allMet}</criteria-met>
<instructions>
Produce a concise executive summary of this round table discussion.

Requirements:
- Lead with the key answer or recommendation (1-2 sentences)
- Include 3-5 bullet points of supporting findings
- Note any unresolved conflicts or escalations
- End with concrete next steps or action items
- Be direct and actionable — this is for decision-makers
- Keep it under 2000 characters
</instructions>
</round-table>`;
}

/**
 * Generate executive summary — calls agent or falls back to extraction.
 */
async function generateExecutiveSummary(
  deps: DeliverDeps,
  query: string,
  convergeOutput: ConvergeOutput,
  config: DeliverConfig,
): Promise<string> {
  try {
    const prompt = buildSummaryPrompt(query, convergeOutput);
    const summary = await Promise.race([
      deps.callAgent(config.summaryAgent, prompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Summary agent timed out")), config.summaryTimeoutMs),
      ),
    ]);

    // Truncate if over limit
    if (summary.length > config.maxSummaryLength) {
      return summary.slice(0, config.maxSummaryLength - 3) + "...";
    }
    return summary;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.warn("Executive summary agent failed, using fallback", { error: errorMsg });
    return buildFallbackSummary(query, convergeOutput);
  }
}

/**
 * Build a fallback executive summary from converge output when agent fails.
 */
export function buildFallbackSummary(
  query: string,
  convergeOutput: ConvergeOutput,
): string {
  const lines: string[] = [];

  lines.push(`**Round Table Result** for: ${query}`);
  lines.push("");

  // Key synthesis (first 500 chars)
  const synthesisTruncated = convergeOutput.synthesis.length > 500
    ? convergeOutput.synthesis.slice(0, 497) + "..."
    : convergeOutput.synthesis;
  lines.push(synthesisTruncated);
  lines.push("");

  if (convergeOutput.agreements.length > 0) {
    lines.push("**Key agreements:**");
    for (const a of convergeOutput.agreements.slice(0, 3)) {
      lines.push(`- ${a.point}`);
    }
    lines.push("");
  }

  if (convergeOutput.escalations.length > 0) {
    lines.push("**Needs attention:**");
    for (const e of convergeOutput.escalations.slice(0, 3)) {
      lines.push(`- ${e}`);
    }
    lines.push("");
  }

  if (!convergeOutput.criteriaStatus.allMet) {
    lines.push("*Note: Not all success criteria were met.*");
  }

  return lines.join("\n");
}

// ── Formation Transcripts ───────────────────────────────────────

/**
 * Extract formation transcripts from the discuss output.
 */
export function extractTranscripts(discussOutput: DiscussOutput): FormationTranscript[] {
  return discussOutput.results.map((r: FormationResult) => ({
    slug: r.slug,
    success: r.success,
    output: r.output,
    error: r.error,
    durationMs: r.durationMs,
  }));
}

// ── Channel Formatting ──────────────────────────────────────────

/**
 * Format the deliver output for Telegram (Markdown).
 */
export function formatForTelegram(
  executiveSummary: string,
  convergeOutput: ConvergeOutput,
  transcripts: FormationTranscript[],
  includeTranscripts: boolean,
): string {
  const lines: string[] = [];

  lines.push("🔵 *Round Table Complete*");
  lines.push("");
  lines.push(executiveSummary);

  if (convergeOutput.escalations.length > 0) {
    lines.push("");
    lines.push("⚠️ *Escalations:*");
    for (const e of convergeOutput.escalations) {
      lines.push(`• ${e}`);
    }
  }

  if (includeTranscripts && transcripts.length > 0) {
    lines.push("");
    lines.push("📋 *Formation Details:*");
    for (const t of transcripts) {
      const status = t.success ? "✅" : "❌";
      lines.push(`${status} *${t.slug}* (${t.durationMs}ms)`);
    }
  }

  const criteriaLine = convergeOutput.criteriaStatus.allMet
    ? "✅ All criteria met"
    : "⚠️ Some criteria not met";
  lines.push("");
  lines.push(criteriaLine);

  return lines.join("\n");
}

/**
 * Format the deliver output for the dashboard (HTML).
 */
export function formatForDashboard(
  executiveSummary: string,
  convergeOutput: ConvergeOutput,
  transcripts: FormationTranscript[],
  includeTranscripts: boolean,
): string {
  const lines: string[] = [];

  lines.push("<div class=\"round-table-result\">");
  lines.push("<h2>Round Table Result</h2>");
  lines.push(`<div class="executive-summary">${escapeHtml(executiveSummary)}</div>`);

  if (convergeOutput.agreements.length > 0) {
    lines.push("<h3>Agreements</h3>");
    lines.push("<ul>");
    for (const a of convergeOutput.agreements) {
      lines.push(`<li><strong>[${a.confidence}]</strong> ${escapeHtml(a.point)}</li>`);
    }
    lines.push("</ul>");
  }

  if (convergeOutput.conflicts.length > 0) {
    lines.push("<h3>Conflicts</h3>");
    lines.push("<ul>");
    for (const c of convergeOutput.conflicts) {
      lines.push(`<li>${escapeHtml(c.point)}`);
      if (c.resolution) {
        lines.push(`<br><em>Resolution: ${escapeHtml(c.resolution)}</em>`);
      }
      lines.push("</li>");
    }
    lines.push("</ul>");
  }

  if (convergeOutput.escalations.length > 0) {
    lines.push("<h3>Escalations</h3>");
    lines.push("<ul class=\"escalations\">");
    for (const e of convergeOutput.escalations) {
      lines.push(`<li>${escapeHtml(e)}</li>`);
    }
    lines.push("</ul>");
  }

  if (includeTranscripts && transcripts.length > 0) {
    lines.push("<h3>Formation Transcripts</h3>");
    lines.push("<details>");
    lines.push("<summary>View formation details</summary>");
    for (const t of transcripts) {
      const statusClass = t.success ? "success" : "failed";
      lines.push(`<div class="transcript ${statusClass}">`);
      lines.push(`<h4>${escapeHtml(t.slug)} <span class="duration">(${t.durationMs}ms)</span></h4>`);
      if (t.success) {
        lines.push(`<pre>${escapeHtml(t.output)}</pre>`);
      } else {
        lines.push(`<p class="error">${escapeHtml(t.error ?? "Unknown error")}</p>`);
      }
      lines.push("</div>");
    }
    lines.push("</details>");
  }

  const criteriaClass = convergeOutput.criteriaStatus.allMet ? "met" : "not-met";
  lines.push(`<div class="criteria-status ${criteriaClass}">`);
  lines.push(convergeOutput.criteriaStatus.allMet
    ? "All criteria met"
    : "Some criteria not met");
  lines.push("</div>");

  lines.push("</div>");

  return lines.join("\n");
}

/**
 * Format the deliver output as plain text.
 */
export function formatForPlain(
  executiveSummary: string,
  convergeOutput: ConvergeOutput,
  transcripts: FormationTranscript[],
  includeTranscripts: boolean,
): string {
  const lines: string[] = [];

  lines.push("=== Round Table Result ===");
  lines.push("");
  lines.push(executiveSummary);

  if (convergeOutput.escalations.length > 0) {
    lines.push("");
    lines.push("ESCALATIONS:");
    for (const e of convergeOutput.escalations) {
      lines.push(`  - ${e}`);
    }
  }

  if (includeTranscripts && transcripts.length > 0) {
    lines.push("");
    lines.push("FORMATION DETAILS:");
    for (const t of transcripts) {
      const status = t.success ? "OK" : "FAIL";
      lines.push(`  [${status}] ${t.slug} (${t.durationMs}ms)`);
    }
  }

  lines.push("");
  lines.push(convergeOutput.criteriaStatus.allMet
    ? "STATUS: All criteria met"
    : "STATUS: Some criteria not met");

  return lines.join("\n");
}

/**
 * Format the output for the appropriate channel.
 */
export function formatForChannel(
  channel: DeliveryChannel,
  executiveSummary: string,
  convergeOutput: ConvergeOutput,
  transcripts: FormationTranscript[],
  includeTranscripts: boolean,
): string {
  switch (channel) {
    case "telegram":
    case "google-chat":
      return formatForTelegram(executiveSummary, convergeOutput, transcripts, includeTranscripts);
    case "dashboard":
      return formatForDashboard(executiveSummary, convergeOutput, transcripts, includeTranscripts);
    case "plain":
    default:
      return formatForPlain(executiveSummary, convergeOutput, transcripts, includeTranscripts);
  }
}

// ── Session Outcome ─────────────────────────────────────────────

/**
 * Build the session outcome record from all phase outputs.
 */
export function buildSessionOutcome(
  sessionId: string,
  query: string,
  conveneOutput: ConveneOutput,
  discussOutput: DiscussOutput,
  convergeOutput: ConvergeOutput,
  channel: DeliveryChannel,
): SessionOutcome {
  return {
    sessionId,
    query,
    success: convergeOutput.success,
    formationsUsed: conveneOutput.selectedFormations.map(f => f.slug),
    formationsSucceeded: discussOutput.succeeded,
    formationsFailed: discussOutput.failed,
    totalDurationMs: discussOutput.totalDurationMs,
    criteriaAllMet: convergeOutput.criteriaStatus.allMet,
    escalationCount: convergeOutput.escalations.length,
    gapCount: convergeOutput.gaps.length,
    channel,
  };
}

// ── Deliver Phase Executor ──────────────────────────────────────

/**
 * Execute the deliver phase:
 *   1. Generate executive summary (agent or fallback)
 *   2. Extract formation transcripts
 *   3. Format output for the delivery channel
 *   4. Build and log session outcome
 *   5. Return structured DeliverOutput
 */
export async function executeDeliver(
  deps: DeliverDeps,
  query: string,
  sessionId: string,
  conveneOutput: ConveneOutput,
  discussOutput: DiscussOutput,
  convergeOutput: ConvergeOutput,
  channel: DeliveryChannel = "telegram",
  config?: Partial<DeliverConfig>,
): Promise<DeliverOutput> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  logger.info("Deliver phase starting", {
    sessionId,
    channel,
    convergeSuccess: convergeOutput.success,
  });

  try {
    // Step 1: Generate executive summary
    const executiveSummary = await generateExecutiveSummary(deps, query, convergeOutput, cfg);
    logger.info("Executive summary generated", { length: executiveSummary.length });

    // Step 2: Extract transcripts
    const transcripts = extractTranscripts(discussOutput);

    // Step 3: Format for channel
    const formattedOutput = formatForChannel(
      channel,
      executiveSummary,
      convergeOutput,
      transcripts,
      cfg.includeTranscripts,
    );

    // Step 4: Build and log session outcome
    const outcome = buildSessionOutcome(
      sessionId,
      query,
      conveneOutput,
      discussOutput,
      convergeOutput,
      channel,
    );

    try {
      await deps.logOutcome(outcome);
      logger.info("Session outcome logged", { sessionId });
    } catch (err) {
      const logErr = err instanceof Error ? err.message : String(err);
      logger.warn("Failed to log session outcome", { error: logErr });
      // Don't fail the phase just because logging failed
    }

    logger.info("Deliver phase complete", {
      sessionId,
      channel,
      summaryLength: executiveSummary.length,
      transcriptCount: transcripts.length,
    });

    return {
      executiveSummary,
      formattedOutput,
      transcripts,
      outcome,
      channel,
      success: true,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error("Deliver phase failed", { error: errorMsg });

    // Even on failure, try to return something useful
    const transcripts = extractTranscripts(discussOutput);
    const outcome = buildSessionOutcome(
      sessionId, query, conveneOutput, discussOutput, convergeOutput, channel,
    );
    outcome.success = false;

    return {
      executiveSummary: "",
      formattedOutput: "",
      transcripts,
      outcome,
      channel,
      success: false,
      error: errorMsg,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────

/** Escape HTML special characters. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Testing Helpers ─────────────────────────────────────────────

/**
 * Create mock deliver deps.
 */
export function _makeMockDeliverDeps(
  agentResponse?: string,
  logFn?: (outcome: SessionOutcome) => Promise<void>,
): DeliverDeps {
  return {
    callAgent: async () =>
      agentResponse ?? "Executive Summary: The round table recommends a balanced expansion strategy with Q2 timeline. Key findings support this direction.",
    logOutcome: logFn ?? (async () => {}),
  };
}

/**
 * Create mock deliver deps where the agent throws.
 */
export function _makeMockDeliverDepsWithAgentFailure(
  logFn?: (outcome: SessionOutcome) => Promise<void>,
): DeliverDeps {
  return {
    callAgent: async () => { throw new Error("Agent unavailable"); },
    logOutcome: logFn ?? (async () => {}),
  };
}

/**
 * Create a mock DeliverOutput for testing downstream consumers.
 */
export function _makeMockDeliverOutput(
  overrides?: Partial<DeliverOutput>,
): DeliverOutput {
  return {
    executiveSummary: "The round table recommends expansion with a Q2 timeline.",
    formattedOutput: "🔵 *Round Table Complete*\n\nThe round table recommends expansion.",
    transcripts: [
      { slug: "boardroom", success: true, output: "Strategic analysis complete.", durationMs: 100 },
      { slug: "think-tank", success: true, output: "Ideas generated.", durationMs: 80 },
    ],
    outcome: {
      sessionId: "test-session-1",
      query: "What should our expansion strategy be?",
      success: true,
      formationsUsed: ["boardroom", "think-tank"],
      formationsSucceeded: ["boardroom", "think-tank"],
      formationsFailed: [],
      totalDurationMs: 120,
      criteriaAllMet: true,
      escalationCount: 0,
      gapCount: 0,
      channel: "telegram",
    },
    channel: "telegram",
    success: true,
    ...overrides,
  };
}
