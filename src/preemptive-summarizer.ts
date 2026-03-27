/**
 * Preemptive Summarization — ELLIE-1058
 * Background compaction when context usage hits threshold.
 * Summarizes older conversation turns before context overflow.
 * Inspired by Context-Gateway internal/preemptive/
 */

import { log } from "./logger.ts";
import { estimateTokens } from "./relay-utils.ts";

const logger = log.child("compression:preemptive");

const DEFAULT_TRIGGER_THRESHOLD = 0.8; // 80% of budget
const KEEP_RECENT_TURNS = 5; // Always keep last 5 turns
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
}

export interface SummarizationResult {
  summary: string;
  turnsConsumed: number;
  originalTokens: number;
  summaryTokens: number;
  triggered: boolean;
}

/**
 * Check if context usage warrants preemptive summarization.
 */
export function shouldTrigger(
  currentTokens: number,
  budget: number,
  threshold: number = DEFAULT_TRIGGER_THRESHOLD
): boolean {
  return currentTokens >= budget * threshold;
}

/**
 * Summarize older conversation turns into a structured summary.
 * Keeps the last N turns intact for continuity.
 */
export async function summarizeConversationHistory(
  turns: ConversationTurn[],
  keepRecent: number = KEEP_RECENT_TURNS
): Promise<SummarizationResult> {
  if (turns.length <= keepRecent) {
    return {
      summary: "",
      turnsConsumed: 0,
      originalTokens: 0,
      summaryTokens: 0,
      triggered: false,
    };
  }

  const toSummarize = turns.slice(0, turns.length - keepRecent);
  const transcript = toSummarize
    .map(t => `[${t.role}]: ${t.content}`)
    .join("\n");
  const originalTokens = estimateTokens(transcript);

  const prompt = `Summarize this conversation history into a structured brief. This summary will replace the original turns in the agent's context.

FORMAT:
## Who We're Working With
[Key people/agents mentioned]

## What We're Working On
[Current task, ticket ID, goal]

## What Just Happened
[Key actions, decisions, findings from the conversation]

## Key Artifacts
[Important file paths, URLs, error messages, values that must be preserved]

## Continue With
[What the agent should do next based on context]

Return ONLY the structured summary, no preamble.

CONVERSATION:
${transcript}`;

  try {
    const { spawn } = await import("bun");
    const args = [
      CLAUDE_PATH, "-p",
      "--output-format", "text",
      "--no-session-persistence",
      "--allowedTools", "",
      "--model", "haiku",
    ];

    const proc = spawn(args, {
      stdin: new Blob([prompt]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDECODE: "", ANTHROPIC_API_KEY: "" },
    });

    const timer = setTimeout(() => proc.kill(), 30_000);
    const output = await new Response(proc.stdout).text();
    clearTimeout(timer);
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      logger.warn("Preemptive summarization failed");
      return {
        summary: "",
        turnsConsumed: 0,
        originalTokens,
        summaryTokens: 0,
        triggered: true,
      };
    }

    const summary = output.trim();
    const summaryTokens = estimateTokens(summary);

    logger.info("Preemptive summarization complete", {
      turnsConsumed: toSummarize.length,
      originalTokens,
      summaryTokens,
      savings: Math.round((1 - summaryTokens / originalTokens) * 100) + "%",
    });

    return {
      summary,
      turnsConsumed: toSummarize.length,
      originalTokens,
      summaryTokens,
      triggered: true,
    };
  } catch (err) {
    logger.error("Preemptive summarization error", { error: String(err) });
    return {
      summary: "",
      turnsConsumed: 0,
      originalTokens,
      summaryTokens: 0,
      triggered: true,
    };
  }
}

/**
 * Apply preemptive summarization to conversation turns if needed.
 * Returns updated turns array (summary replaces old turns, recent preserved).
 */
export async function applyPreemptiveSummarization(
  turns: ConversationTurn[],
  currentTokens: number,
  budget: number,
  opts?: { threshold?: number; keepRecent?: number }
): Promise<{ turns: ConversationTurn[]; result: SummarizationResult }> {
  const threshold = opts?.threshold ?? DEFAULT_TRIGGER_THRESHOLD;
  const keepRecent = opts?.keepRecent ?? KEEP_RECENT_TURNS;

  if (!shouldTrigger(currentTokens, budget, threshold)) {
    return {
      turns,
      result: {
        summary: "",
        turnsConsumed: 0,
        originalTokens: 0,
        summaryTokens: 0,
        triggered: false,
      },
    };
  }

  const result = await summarizeConversationHistory(turns, keepRecent);

  if (!result.summary) {
    return { turns, result };
  }

  // Replace old turns with summary + keep recent
  const recentTurns = turns.slice(turns.length - keepRecent);
  const summaryTurn: ConversationTurn = {
    role: "assistant",
    content: `[Previous conversation summarized]\n\n${result.summary}`,
    timestamp: new Date().toISOString(),
  };

  return {
    turns: [summaryTurn, ...recentTurns],
    result,
  };
}

// Export for testing
export { DEFAULT_TRIGGER_THRESHOLD, KEEP_RECENT_TURNS };
