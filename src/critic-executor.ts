/**
 * ELLIE-524 — Critic-loop executor (iterative refinement mode).
 *
 * Runs a producer→critic loop for up to MAX_CRITIC_ROUNDS rounds.
 * Stops early when the critic approves. Falls back gracefully when
 * the critic returns malformed JSON (ELLIE-72).
 */

import { processMemoryIntents } from "./memory.ts";
import { extractApprovalTags } from "./approval.ts";
import { log } from "./logger.ts";
import { executeStep } from "./step-runner.ts";
import {
  type PipelineStep,
  type OrchestratorOptions,
  type ArtifactStore,
  type ExecutionResult,
  PipelineStepError,
  MAX_CRITIC_ROUNDS,
  MAX_PREVIOUS_OUTPUT_CHARS,
  MAX_COST_PER_EXECUTION,
} from "./orchestrator-types.ts";
import type { DispatchResult } from "./agent-router.ts";

const logger = log.child("orchestrator");

interface CriticVerdict {
  accepted: boolean;
  feedback: string;
  score: number;
  issues: string[];
}

export async function executeCriticLoop(
  steps: PipelineStep[],
  originalMessage: string,
  options: OrchestratorOptions,
  artifacts: ArtifactStore,
): Promise<ExecutionResult> {
  // Exactly 2 skills: producer and critic
  const producer = steps[0];
  const critic = steps.length > 1
    ? steps[1]
    : { agent_name: "critic", skill_name: "critical_review", instruction: "Review and provide constructive feedback" };

  logger.info("Critic-loop started", { producer: `${producer.agent_name}/${producer.skill_name || "none"}`, critic: `${critic.agent_name}/${critic.skill_name || "none"}` });

  let producerOutput = "";
  let feedback: string | null = null;
  let finalDispatch: DispatchResult | null = null;
  let round = 0;
  let costTruncated = false;

  for (round = 0; round < MAX_CRITIC_ROUNDS; round++) {
    // 1. Producer generates
    const producerInstruction = round === 0
      ? producer.instruction
      : `${producer.instruction}\n\nPrevious feedback to address:\n${feedback}\n\nImprove your previous output based on this feedback.`;

    const producerStep: PipelineStep = { ...producer, instruction: producerInstruction };

    const { stepResult: producerResult, dispatch: producerDispatch } = await executeStep(
      producerStep, round * 2, MAX_CRITIC_ROUNDS * 2,
      originalMessage, round > 0 ? producerOutput : null, options,
      "intermediate",
    );

    finalDispatch = producerDispatch;
    artifacts.steps.push(producerResult);
    artifacts.total_duration_ms += producerResult.duration_ms;
    artifacts.total_input_tokens += producerResult.input_tokens;
    artifacts.total_output_tokens += producerResult.output_tokens;
    artifacts.total_cost_usd += producerResult.cost_usd;

    // Cost guard — flag partial result so the caller knows refinement was cut short
    if (artifacts.total_cost_usd > MAX_COST_PER_EXECUTION) {
      logger.error("Critic-loop aborted: cost exceeds limit", { cost: artifacts.total_cost_usd, limit: MAX_COST_PER_EXECUTION });
      costTruncated = true;
      break;
    }

    producerOutput = await processMemoryIntents(options.supabase, producerResult.output, producerStep.agent_name);
    const { cleanedText } = extractApprovalTags(producerOutput);
    producerOutput = cleanedText;

    if (options.onHeartbeat) options.onHeartbeat();

    // 2. Critic evaluates
    const criticInstruction =
      `Evaluate the following output for the request: "${originalMessage}"\n\n` +
      `Output to review:\n---\n${producerOutput.substring(0, MAX_PREVIOUS_OUTPUT_CHARS)}\n---\n\n` +
      `Respond with ONLY a JSON object (no markdown fences):\n` +
      `{"accepted": true/false, "score": 1-10, "feedback": "overall assessment", "issues": ["specific issue 1", "specific issue 2"]}`;

    const criticStep: PipelineStep = { ...critic, instruction: criticInstruction };

    const { stepResult: criticResult, dispatch: criticDispatch } = await executeStep(
      criticStep, round * 2 + 1, MAX_CRITIC_ROUNDS * 2,
      originalMessage, null, options,
      "intermediate",
    );

    if (criticDispatch) finalDispatch = criticDispatch;
    artifacts.steps.push(criticResult);
    artifacts.total_duration_ms += criticResult.duration_ms;
    artifacts.total_input_tokens += criticResult.input_tokens;
    artifacts.total_output_tokens += criticResult.output_tokens;
    artifacts.total_cost_usd += criticResult.cost_usd;

    if (options.onHeartbeat) options.onHeartbeat();

    // 3. Parse critic verdict
    const verdict = parseCriticVerdict(criticResult.output, round);

    logger.info("Critic round complete", { round: round + 1, score: verdict.score, accepted: verdict.accepted });

    if (verdict.accepted) {
      break;
    }

    feedback = verdict.feedback;
  }

  if (!finalDispatch) {
    throw new PipelineStepError(0, producer, "dispatch_failed", producerOutput || null);
  }

  return {
    finalResponse: producerOutput,
    artifacts,
    stepResults: artifacts.steps,
    finalDispatch,
    mode: "critic-loop",
    ...(costTruncated ? { cost_truncated: true } : {}),
  };
}

export function parseCriticVerdict(output: string, round: number): CriticVerdict {
  try {
    const cleaned = output
      .trim()
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```\s*$/m, "");
    const parsed = JSON.parse(cleaned);
    const issues: string[] = Array.isArray(parsed.issues)
      ? parsed.issues.map((i: unknown) => String(i).slice(0, 500)).slice(0, 10)
      : [];
    // Combine feedback + issues for actionable revision guidance
    const feedback = String(parsed.feedback || "No specific feedback provided.").slice(0, 2000);
    const fullFeedback = issues.length > 0
      ? `${feedback}\n\nSpecific issues:\n${issues.map((i, idx) => `${idx + 1}. ${i}`).join("\n")}`
      : feedback;
    return {
      accepted: Boolean(parsed.accepted),
      score: Math.min(Math.max(typeof parsed.score === "number" ? parsed.score : 5, 1), 10),
      feedback: fullFeedback,
      issues,
    };
  } catch {
    // Log the raw output so malformed critic responses are debuggable
    const truncatedRaw = output.length > 500 ? output.substring(0, 500) + "..." : output;
    const isFinalRound = round >= MAX_CRITIC_ROUNDS - 1;
    logger.warn(
      `Could not parse critic verdict, ${isFinalRound ? "accepting (final round)" : "rejecting for retry"}`,
      { round: round + 1, maxRounds: MAX_CRITIC_ROUNDS, rawOutput: truncatedRaw },
    );
    return {
      accepted: isFinalRound,
      score: isFinalRound ? 5 : 3,
      feedback: isFinalRound
        ? "Critic returned malformed response on final round — accepted with caveats. Review output manually."
        : "Unable to parse critic feedback. Please revise and provide clearer output.",
      issues: isFinalRound ? ["critic-parse-error: malformed JSON on final round"] : [],
    };
  }
}
