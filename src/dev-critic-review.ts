/**
 * Dev-Critic Review — ELLIE-614
 *
 * Integrates the critic agent into the dev workflow via the inter-agent
 * request system. When dev completes significant work, this module
 * builds a review context and submits a request to critic.
 *
 * The critic provides structured feedback: issues by severity,
 * positive observations, and a ship/no-ship recommendation.
 *
 * Pure module — builds review requests and parses responses.
 * I/O (submitting requests) is handled by the caller or wired
 * into the work-session complete flow.
 */

import {
  submitAgentRequest,
  approveAgentRequest,
  completeAgentRequest,
  type AgentRequest,
  type CreateAgentRequestInput,
} from "./agent-request.ts";
import {
  openExchange,
  addMessage,
  completeExchange,
  type AgentExchange,
} from "./agent-exchange.ts";
import { registerAgent, type RegisteredAgent } from "./agent-registry.ts";
import { createCommitment, type Commitment } from "./commitment-ledger.ts";

// ── Types ────────────────────────────────────────────────────────────────────

/** Context for a critic review request. */
export interface ReviewContext {
  workItemId: string;
  summary: string;
  filesChanged?: string[];
  testsPassed?: boolean;
  agent?: string;
}

/** A single issue found by the critic. */
export interface ReviewIssue {
  severity: "critical" | "warning" | "note";
  location?: string;
  description: string;
  suggestion?: string;
}

/** Structured feedback from the critic. */
export interface CriticFeedback {
  recommendation: "ship" | "no-ship" | "conditional";
  issues: ReviewIssue[];
  positives: string[];
  summary: string;
}

/** Result of requesting a critic review. */
export type ReviewRequestResult =
  | { success: true; requestId: string; exchangeId: string }
  | { success: false; reason: string };

// ── Review Context Building ─────────────────────────────────────────────────

/**
 * Build the context message that gets sent to the critic.
 * This is what the critic sees as the review brief.
 */
export function buildReviewBrief(ctx: ReviewContext): string {
  const lines: string[] = [
    `## Review Request — ${ctx.workItemId}`,
    "",
    `**Summary**: ${ctx.summary}`,
  ];

  if (ctx.agent) {
    lines.push(`**Agent**: ${ctx.agent}`);
  }

  if (ctx.filesChanged && ctx.filesChanged.length > 0) {
    lines.push("", "**Files Changed**:");
    for (const file of ctx.filesChanged) {
      lines.push(`- ${file}`);
    }
  }

  if (ctx.testsPassed !== undefined) {
    lines.push("", `**Tests**: ${ctx.testsPassed ? "passing" : "FAILING"}`);
  }

  lines.push(
    "",
    "## Review Instructions",
    "",
    "Evaluate this work and provide structured feedback:",
    "1. List issues by severity (critical, warning, note)",
    "2. Note what works well (positives)",
    "3. Provide a ship/no-ship/conditional recommendation",
    "4. For each issue, include location and suggested fix",
  );

  return lines.join("\n");
}

/**
 * Parse critic feedback from a response string.
 * Expects JSON with the CriticFeedback structure.
 * Falls back to a simple text summary if JSON parsing fails.
 */
export function parseCriticFeedback(responseText: string): CriticFeedback {
  try {
    const cleaned = responseText
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```\s*$/m, "")
      .trim();
    const parsed = JSON.parse(cleaned);

    return {
      recommendation: parsed.recommendation || "conditional",
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      positives: Array.isArray(parsed.positives) ? parsed.positives : [],
      summary: parsed.summary || responseText.substring(0, 200),
    };
  } catch {
    return {
      recommendation: "conditional",
      issues: [],
      positives: [],
      summary: responseText.substring(0, 500),
    };
  }
}

/**
 * Format critic feedback for display (Telegram/log).
 */
export function formatFeedback(feedback: CriticFeedback): string {
  const lines: string[] = [];

  const icon = feedback.recommendation === "ship" ? "SHIP"
    : feedback.recommendation === "no-ship" ? "NO-SHIP"
    : "CONDITIONAL";
  lines.push(`**Critic Review: ${icon}**`);
  lines.push("");
  lines.push(feedback.summary);

  if (feedback.issues.length > 0) {
    lines.push("");
    lines.push("**Issues:**");
    for (const issue of feedback.issues) {
      const sev = issue.severity === "critical" ? "[CRITICAL]"
        : issue.severity === "warning" ? "[WARNING]"
        : "[NOTE]";
      const loc = issue.location ? ` (${issue.location})` : "";
      lines.push(`- ${sev}${loc} ${issue.description}`);
      if (issue.suggestion) {
        lines.push(`  Fix: ${issue.suggestion}`);
      }
    }
  }

  if (feedback.positives.length > 0) {
    lines.push("");
    lines.push("**What works well:**");
    for (const pos of feedback.positives) {
      lines.push(`- ${pos}`);
    }
  }

  return lines.join("\n");
}

// ── Review Request Flow ─────────────────────────────────────────────────────

/**
 * Ensure the critic agent is registered in the agent registry.
 * Idempotent — safe to call multiple times.
 */
export function ensureCriticRegistered(): RegisteredAgent {
  return registerAgent({
    agentName: "critic",
    agentType: "specialist",
    capabilities: [
      { name: "code-review", description: "Review code for correctness, edge cases, and patterns" },
      { name: "architecture-review", description: "Check architectural consistency" },
    ],
  });
}

/**
 * Request a critic review of completed work.
 *
 * Flow:
 *  1. Ensure critic is registered
 *  2. Create a parent commitment for the review
 *  3. Submit inter-agent request (dev → critic)
 *  4. Auto-approve (since this is a system-initiated request)
 *  5. Open exchange with review brief
 *
 * Returns the request ID and exchange ID for tracking.
 */
export function requestCriticReview(
  sessionId: string,
  ctx: ReviewContext,
  turnNumber: number = 0,
): ReviewRequestResult {
  // Ensure critic is available
  ensureCriticRegistered();

  // Create parent commitment
  const commitment = createCommitment({
    sessionId,
    description: `Critic review for ${ctx.workItemId}`,
    source: "dispatch",
    turnCreated: turnNumber,
    workItemId: ctx.workItemId,
  });

  if (!commitment) {
    return { success: false, reason: "Failed to create commitment" };
  }

  // Submit request
  const requestInput: CreateAgentRequestInput = {
    sessionId,
    parentCommitmentId: commitment.id,
    requestingAgent: ctx.agent || "dev",
    targetAgent: "critic",
    reason: `Review completed work on ${ctx.workItemId}: ${ctx.summary}`,
    estimatedDuration: 5,
    requiredCapability: "code-review",
  };

  const submitResult = submitAgentRequest(requestInput);
  if ("error" in submitResult) {
    return { success: false, reason: submitResult.error };
  }

  // Auto-approve (system-initiated review)
  const approvalResult = approveAgentRequest(submitResult.request.id, turnNumber);
  if ("error" in approvalResult) {
    return { success: false, reason: approvalResult.error };
  }

  // Open exchange with review brief
  const brief = buildReviewBrief(ctx);
  const { exchange } = openExchange({
    agentRequestId: submitResult.request.id,
    requestingAgent: ctx.agent || "dev",
    targetAgent: "critic",
    context: brief,
  });

  return {
    success: true,
    requestId: submitResult.request.id,
    exchangeId: exchange.id,
  };
}

/**
 * Complete a critic review exchange with the critic's feedback.
 * Parses the feedback and closes the exchange + request.
 */
export function completeCriticReview(
  exchangeId: string,
  requestId: string,
  criticResponse: string,
): { feedback: CriticFeedback; formatted: string } | { error: string } {
  // Add the critic's response as a message
  const updated = addMessage(exchangeId, "critic", criticResponse);
  if (!updated) {
    return { error: "Exchange not found or not active" };
  }

  // Parse feedback
  const feedback = parseCriticFeedback(criticResponse);
  const formatted = formatFeedback(feedback);

  // Complete the exchange
  const exchangeResult = completeExchange(exchangeId, feedback.summary);
  if (!exchangeResult) {
    return { error: "Failed to complete exchange" };
  }

  // Complete the request
  completeAgentRequest(requestId);

  return { feedback, formatted };
}
