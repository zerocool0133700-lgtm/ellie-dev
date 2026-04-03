/**
 * Coordinator Loop — Core Module
 *
 * The heart of Ellie's orchestration: a Think-Act-Observe-Think cycle
 * that maintains a conversation with Claude via the Messages API.
 * Replaces the stateless router with a stateful coordinator that can
 * dispatch specialists, read context, and deliver final responses.
 */

import Anthropic from "@anthropic-ai/sdk";
import { log } from "./logger.ts";
import type { FoundationRegistry } from "./foundation-registry.ts";
import { CoordinatorContext } from "./coordinator-context.ts";
import {
  COORDINATOR_TOOL_DEFINITIONS,
  type DispatchAgentInput,
  type AskUserInput,
  type ReadContextInput,
  type UpdateUserInput,
  type CompleteInput,
  type InvokeRecipeInput,
} from "./coordinator-tools.ts";
import {
  createEnvelope,
  completeEnvelope,
  failEnvelope,
  computeCost,
  type DispatchEnvelope,
} from "./dispatch-envelope.ts";
import { rebuildDispatchStateFromGTD } from "./gtd-recovery.ts";
import { formatQuestionMessage } from "./telegram-question-format.ts";
import { emitDispatchEvent } from "./dispatch-events.ts";
import { writeOutcome } from "./dispatch-outcomes.ts";
import { checkQueuedContext, clearQueuedContext } from "./dispatch-context-queue.ts";

const logger = log.child("coordinator");

// ── Types ───────────────────────────────────────────────────────────────────

export interface SpecialistResult {
  agent: string;
  status: "completed" | "error";
  output: string;
  error?: string;
  tokens_used: number;
  cost_usd: number;
  duration_ms: number;
}

export interface CoordinatorDeps {
  callSpecialist: (agent: string, task: string, context?: string, timeoutMs?: number) => Promise<SpecialistResult>;
  sendMessage: (channel: string, message: string) => Promise<void>;
  sendEvent: (event: Record<string, unknown>) => Promise<void>;  // ELLIE-1099: WebSocket events for UI
  readForest: (query: string) => Promise<string>;
  readPlane: (query: string) => Promise<string>;
  readMemory: (query: string) => Promise<string>;
  readSessions: (query: string) => Promise<string>;
  getWorkingMemorySummary: () => Promise<string>;
  updateWorkingMemory: (sections: Record<string, string>) => Promise<void>;
  promoteToForest: () => Promise<void>;
  logEnvelope: (envelope: DispatchEnvelope) => Promise<void>;
}

export interface CoordinatorOpts {
  message: string;
  channel: string;
  userId: string;
  foundation: string;
  systemPrompt: string;
  model: string;
  agentRoster: string[];
  deps: CoordinatorDeps;
  registry?: FoundationRegistry;
  coordinatorAgent?: string;  // Agent running the coordinator loop (default: "max")
  maxIterations?: number;
  sessionTimeoutMs?: number;
  costCapUsd?: number;
  workItemId?: string;
  resumeState?: CoordinatorPausedState;  // ELLIE-1101: resume from ask_user pause
  _testResponses?: Array<{
    stop_reason: string;
    content: Array<Record<string, unknown>>;
    usage: { input_tokens: number; output_tokens: number };
  }>;
  _apiCallFn?: () => Promise<{
    stop_reason: string;
    content: Array<Record<string, unknown>>;
    usage: { input_tokens: number; output_tokens: number };
  }>;
}

export interface CoordinatorPausedState {
  messages: unknown[];      // Serialized Messages API conversation
  systemPrompt: string;
  toolUseId: string;        // The ask_user tool_use ID to resume with
  question: string;         // What was asked
  foundation: string;
  model: string;
  agentRoster: string[];
  envelopes: DispatchEnvelope[];
  totalTokensIn: number;
  totalTokensOut: number;
  iteration: number;
  orchestrationParentId?: string | null;  // ELLIE-1152: Survive resume without forking GTD tree
  lastDispatchChildId?: string | null;    // ELLIE-1152: Last agent's GTD child item for question parenting
  questionMetadata?: {                    // ELLIE-1276: Structured metadata for formatted question messages
    question_id: string;
    what_i_need: string;
    decision_unlocked: string;
    answer_format?: string;
    choices?: string[];
    agentName: string;
  };
}

export interface CoordinatorResult {
  response: string;
  loopIterations: number;
  envelopes: DispatchEnvelope[];
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  hitSafetyRail: boolean;
  durationMs: number;
  paused?: CoordinatorPausedState;  // ELLIE-1101: set when ask_user pauses the loop
}

// ── Constants ───────────────────────────────────────────────────────────────

/**
 * LIMITS RELAXED (2026-03-30): Single-user Mac subscription — the original
 * values (10 iterations, 20min timeout, $2 cost cap) were cutting off complex
 * coordinator work. Original intent: prevent runaway loops and costs in
 * multi-user scenarios. Tighten these when onboarding external users.
 */
const DEFAULT_MAX_ITERATIONS = 50;           // was 10
const DEFAULT_SESSION_TIMEOUT_MS = 60 * 60 * 1000; // was 20min, now 60min
const DEFAULT_COST_CAP_USD = 50.0;           // was $2.00
const MAX_CONTEXT_TOKENS = 200_000;

// ── Main Loop ───────────────────────────────────────────────────────────────

export async function runCoordinatorLoop(opts: CoordinatorOpts): Promise<CoordinatorResult> {
  const {
    message,
    channel,
    foundation,
    systemPrompt,
    model,
    agentRoster,
    deps,
    workItemId,
    _testResponses,
    _apiCallFn,
  } = opts;

  const maxIterationsRaw = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const sessionTimeoutMs = opts.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const costCapRaw = opts.costCapUsd ?? DEFAULT_COST_CAP_USD;

  // Foundation-aware defaults: registry values override opts, with raw values as fallback
  const behavior = opts.registry?.getBehavior();
  const effectiveMaxIterations = behavior?.max_loop_iterations ?? maxIterationsRaw;
  const effectiveCostCap = behavior?.cost_cap_session ?? costCapRaw;
  const effectiveModel = behavior?.coordinator_model ?? model;
  const effectiveRoster = opts.registry?.getAgentRoster() ?? agentRoster;
  const effectiveCoordinatorAgent = opts.coordinatorAgent
    ?? opts.registry?.getCoordinatorAgent()
    ?? "max";
  const effectivePrompt = opts.registry ? await opts.registry.getCoordinatorPrompt() : systemPrompt;

  const startTime = Date.now();
  const isTestMode = !!_testResponses;
  let testResponseIdx = 0;

  // System prompt comes from the foundation registry (includes roster, recipes, behavior)
  // Only append roster if using a raw prompt (no registry)
  const fullSystemPrompt = opts.registry
    ? effectivePrompt
    : `${effectivePrompt}\n\n## Available Agents\n${effectiveRoster.join(", ")}`;

  // 1. Create coordinator context
  const ctx = new CoordinatorContext({
    systemPrompt: fullSystemPrompt,
    maxTokens: MAX_CONTEXT_TOKENS,
  });

  // 2. Create coordinator envelope
  const coordEnvelope = createEnvelope({
    type: "coordinator",
    agent: effectiveCoordinatorAgent,
    foundation,
    model: effectiveModel,
    work_item_id: workItemId,
  });

  const envelopes: DispatchEnvelope[] = [coordEnvelope];

  // Tracking
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let specialistCostUsd = 0;
  let hitSafetyRail = false;
  let loopStartIteration = 0;
  let orchestrationParentId: string | null = null; // ELLIE-1152: GTD dispatch tracking
  let lastDispatchChildId: string | null = null;   // ELLIE-1152: Last agent's GTD child item for question parenting

  // ELLIE-1101: Resume from ask_user pause
  if (opts.resumeState) {
    const rs = opts.resumeState;
    logger.info("Resuming coordinator from ask_user pause", { toolUseId: rs.toolUseId, question: rs.question.slice(0, 100) });

    // ELLIE-1152: Restore GTD parent/child IDs so we don't fork the tree on resume
    orchestrationParentId = rs.orchestrationParentId ?? null;
    lastDispatchChildId = rs.lastDispatchChildId ?? null;

    // Restore conversation history
    for (const msg of rs.messages) {
      const m = msg as { role: string; content: unknown };
      if (m.role === "user") {
        if (typeof m.content === "string") ctx.addUserMessage(m.content);
        else if (Array.isArray(m.content)) {
          // Tool results — add raw
          for (const block of m.content as Array<Record<string, unknown>>) {
            if (block.type === "tool_result") {
              ctx.addToolResult(block.tool_use_id as string, (block.content as string) ?? "");
            }
          }
        }
      } else if (m.role === "assistant") {
        ctx.addAssistantMessage(m.content as Anthropic.ContentBlockParam[]);
      }
    }

    // Feed the user's reply as the tool result for the ask_user call
    ctx.addToolResult(rs.toolUseId, JSON.stringify({ response: message, timed_out: false }));

    // Restore tracking state
    totalTokensIn = rs.totalTokensIn;
    totalTokensOut = rs.totalTokensOut;
    envelopes.push(...rs.envelopes.slice(1)); // Skip the coord envelope (we made a new one)
    loopStartIteration = rs.iteration;
  } else {
    // 3. Add user message (normal start)
    ctx.addUserMessage(message);
  }
  let response = "";
  let loopIterations = 0;

  // Anthropic client (only created if not in test mode and no custom call fn)
  let client: Anthropic | null = null;
  if (!isTestMode && !_apiCallFn) {
    client = new Anthropic();
  }

  // 4. LOOP
  for (let iteration = 0; iteration < effectiveMaxIterations; iteration++) {
    loopIterations = iteration + 1;

    // 4a. Check wall-clock timeout
    if (Date.now() - startTime > sessionTimeoutMs) {
      hitSafetyRail = true;
      response = "I've reached the session time limit. Here's what I've accomplished so far — please send a follow-up message to continue.";
      logger.warn("Session timeout reached", { iteration, elapsed: Date.now() - startTime });
      break;
    }

    // Check cost cap — ONLY coordinator API cost counts (specialists run on Max subscription via CLI)
    // ELLIE-1136: Specialist cost is computed but not real — CLI uses subscription, not API credits
    const coordinatorCost = computeCost(effectiveModel, totalTokensIn, totalTokensOut);
    if (coordinatorCost > effectiveCostCap) {
      hitSafetyRail = true;
      response = "I've reached the cost limit for this session. Here's what I've accomplished so far.";
      logger.warn("Cost cap reached", { iteration, coordinatorCost, specialistCost: specialistCostUsd, cap: effectiveCostCap });
      break;
    }

    // 4b. Call Messages API (or use test responses)
    let apiResponse: {
      stop_reason: string;
      content: Array<Record<string, unknown>>;
      usage: { input_tokens: number; output_tokens: number };
    };

    if (isTestMode && !_apiCallFn) {
      if (testResponseIdx >= _testResponses!.length) {
        hitSafetyRail = true;
        response = "Test responses exhausted.";
        break;
      }
      apiResponse = _testResponses![testResponseIdx++];
    } else {
      try {
        if (_apiCallFn) {
          apiResponse = await _apiCallFn();
        } else {
          const anthropicResponse = await callMessagesAPI(client!, {
            model: effectiveModel,
            systemPrompt: ctx.getSystemPrompt(),
            messages: ctx.getMessages(),
          });
          apiResponse = {
            stop_reason: anthropicResponse.stop_reason ?? "end_turn",
            content: anthropicResponse.content as unknown as Array<Record<string, unknown>>,
            usage: anthropicResponse.usage,
          };
        }
      } catch (err: unknown) {
        // Rate limit: exponential backoff
        if (isRateLimitError(err)) {
          const backoff = Math.min(1000 * Math.pow(2, iteration), 30000);
          logger.warn("Rate limited, backing off", { backoff, iteration });
          await sleep(backoff);
          iteration--; // Don't count rate-limit retries against iteration budget
          continue;
        }
        // Unknown API error: break with safety rail
        hitSafetyRail = true;
        response = "I encountered an unexpected error communicating with Claude. Please try again.";
        logger.error("API error", { error: err instanceof Error ? err.message : String(err) });
        break;
      }
    }

    // 4c. Track tokens
    totalTokensIn += apiResponse.usage.input_tokens;
    totalTokensOut += apiResponse.usage.output_tokens;
    ctx.recordTokenUsage(totalTokensIn);

    // 4d. Add assistant response to context
    ctx.addAssistantMessage(apiResponse.content as unknown as Anthropic.ContentBlockParam[]);

    // 4e. If end_turn: extract text and break
    if (apiResponse.stop_reason === "end_turn") {
      response = extractText(apiResponse.content);
      if (!response) {
        logger.warn("end_turn with empty text — forcing a completion message");
        response = "I processed your request but the response was empty. Please try again.";
      }
      break;
    }

    // 4f. Process tool calls
    const toolUses = apiResponse.content.filter(
      (block) => block.type === "tool_use"
    );

    if (toolUses.length === 0) {
      // No tool calls and not end_turn — extract text and break
      response = extractText(apiResponse.content);
      break;
    }

    let shouldBreak = false;

    // Separate dispatch_agent calls (parallel) from other tools (sequential)
    const dispatchCalls: Array<Record<string, unknown>> = [];
    const otherCalls: Array<Record<string, unknown>> = [];

    for (const tool of toolUses) {
      if (tool.name === "complete") {
        // Handle complete tool — extract response, optionally promote
        const input = tool.input as unknown as CompleteInput;
        response = input.response || "";
        logger.info("Complete tool called", { responseLength: response.length, responsePreview: response.slice(0, 200) });

        if (input.promote_to_memory) {
          try {
            await deps.promoteToForest();
          } catch (err) {
            logger.error("Failed to promote to forest", { error: err instanceof Error ? err.message : String(err) });
          }
        }

        // Feed tool result back
        ctx.addToolResult(tool.id as string, JSON.stringify({ status: "completed", response: input.response }));
        shouldBreak = true;
        break;
      } else if (tool.name === "ask_user") {
        // ELLIE-1101: Pause the loop — save state so next message can resume
        const askInput = tool.input as unknown as AskUserInput;

        // ELLIE-1264: Validate choice format requires non-empty choices array
        if (askInput.answer_format === 'choice' && (!askInput.choices || askInput.choices.length === 0)) {
          logger.warn("ask_user with answer_format='choice' but no choices — falling back to text format");
          askInput.answer_format = 'text';
        }

        // ELLIE-1276: Generate question ID upfront so it's shared between GTD item and paused state metadata
        let questionId: string;
        try {
          const gtdMod = await import("./gtd-orchestration.ts");
          questionId = gtdMod.generateQuestionId();
        } catch {
          questionId = `q-${Math.random().toString(16).slice(2, 10)}`;
        }

        // ELLIE-1276: Format the question with structured metadata before sending
        const formattedQuestion = formatQuestionMessage({
          agentName: "ellie",
          questionId,
          question: askInput.question,
          whatINeed: askInput.what_i_need ?? "",
          decisionUnlocked: askInput.decision_unlocked ?? "",
          choices: askInput.choices,
        });
        await deps.sendMessage(channel, formattedQuestion);
        logger.info("ask_user pausing loop", { question: askInput.question.slice(0, 200), toolUseId: tool.id });

        // ELLIE-1152: Create question item in GTD for dispatch panel visibility
        // Parent under the last dispatched agent's child item if available,
        // otherwise fall back to the orchestration root parent.
        // NOTE: If multiple agents were dispatched in parallel, lastDispatchChildId
        // points to the last one resolved — may not be the agent that triggered the question.
        if (orchestrationParentId) {
          try {
            const gtdMod = await import("./gtd-orchestration.ts");
            const questionParent = lastDispatchChildId || orchestrationParentId;
            await gtdMod.createQuestionItem({
              parentId: questionParent,
              content: askInput.question,
              createdBy: effectiveCoordinatorAgent,
              urgency: askInput.urgency === "high" ? "blocking" : "normal",
              metadata: {
                question_id: questionId,
                what_i_need: askInput.what_i_need,
                decision_unlocked: askInput.decision_unlocked,
                answer_format: askInput.answer_format ?? "text",
                choices: askInput.choices ?? null,
              },
            }).catch((err: unknown) => logger.warn("GTD question item creation failed", { error: err instanceof Error ? err.message : String(err) }));
          } catch (err) { logger.warn("GTD question import failed", { error: err instanceof Error ? err.message : String(err) }); }
        }

        // Add the assistant message with the ask_user tool_use to context before saving
        // (it was already added above via addAssistantMessage)
        // Save the full conversation state for resume
        const pausedState: CoordinatorPausedState = {
          messages: ctx.getMessages() as unknown[],
          systemPrompt: fullSystemPrompt,
          toolUseId: tool.id as string,
          question: askInput.question,
          foundation,
          model: effectiveModel,
          agentRoster: effectiveRoster,
          envelopes: [...envelopes],
          totalTokensIn,
          totalTokensOut,
          iteration: loopIterations,
          orchestrationParentId,       // ELLIE-1152: Preserve GTD tree across resume
          lastDispatchChildId,         // ELLIE-1152: Preserve for question parenting
          questionMetadata: {          // ELLIE-1276: Metadata for formatted question display
            question_id: questionId,
            what_i_need: askInput.what_i_need ?? "",
            decision_unlocked: askInput.decision_unlocked ?? "",
            answer_format: askInput.answer_format,
            choices: askInput.choices,
            agentName: "ellie",
          },
        };

        // Return with paused state — the handler will store this
        const durationMs = Date.now() - startTime;
        const finalEnvelope = completeEnvelope(coordEnvelope, { tokens_in: totalTokensIn, tokens_out: totalTokensOut, model: effectiveModel });
        envelopes[0] = finalEnvelope;

        return {
          response: askInput.question,
          loopIterations,
          envelopes,
          totalTokensIn,
          totalTokensOut,
          totalCostUsd: computeCost(effectiveModel, totalTokensIn, totalTokensOut) + specialistCostUsd,
          hitSafetyRail: false,
          durationMs,
          paused: pausedState,
        };
      } else if (tool.name === "dispatch_agent") {
        dispatchCalls.push(tool);
      } else {
        otherCalls.push(tool);
      }
    }

    if (shouldBreak) break;

    // ELLIE-1152: Cache GTD module import — avoid repeated dynamic imports in the dispatch loop
    const gtdModule = await import("./gtd-orchestration.ts").catch((err) => {
      logger.warn("GTD orchestration module unavailable", { error: err instanceof Error ? err.message : String(err) });
      return null;
    });

    // Run all dispatch_agent calls in parallel
    if (dispatchCalls.length > 0) {
      // ELLIE-1152: Create orchestration parent BEFORE entering parallel block to avoid
      // race condition where multiple parallel dispatches each try to create the parent
      if (!orchestrationParentId && gtdModule) {
        try {
          const parent = await gtdModule.createOrchestrationParent({
            content: message.slice(0, 200),
            createdBy: effectiveCoordinatorAgent,
            sourceRef: workItemId,
          }).catch(() => null);
          if (parent) orchestrationParentId = parent.id;
        } catch (err) {
          logger.warn("GTD parent creation failed", { error: err instanceof Error ? err.message : String(err) });
        }
      }

      const dispatchPromises = dispatchCalls.map(async (tool) => {
        const input = tool.input as unknown as DispatchAgentInput;
        const toolId = tool.id as string;

        // Validate agent is in roster
        if (!effectiveRoster.includes(input.agent)) {
          const errorMsg = `Agent "${input.agent}" is not in the roster. Available: ${effectiveRoster.join(", ")}`;
          logger.warn("Agent not in roster", { agent: input.agent, roster: effectiveRoster });
          return { toolId, result: errorMsg };
        }

        // Create specialist envelope
        const specEnvelope = createEnvelope({
          type: "specialist",
          agent: input.agent,
          foundation,
          parent_id: coordEnvelope.id,
          model: effectiveModel,
          work_item_id: workItemId,
        });

        // DEPRECATED: Remove after dashboard migrates to dispatch_event (ELLIE-1308)
        // ELLIE-1099: Send spawn_status so dashboard shows agent activity
        try {
          await deps.sendEvent({
            type: "spawn_status",
            spawnId: specEnvelope.id,
            agent: input.agent,
            task: input.task.slice(0, 200),
            status: "running",
            ts: Date.now(),
          });
        } catch { /* best-effort */ }

        // Unified dispatch event (ELLIE-1308)
        emitDispatchEvent(specEnvelope.id, "dispatched", {
          agent: input.agent,
          title: input.task.slice(0, 200),
          work_item_id: workItemId,
          dispatch_type: "single",
        });

        // ELLIE-1152: Create GTD child item for dispatch tracking
        let gtdItem: { id: string } | null = null;
        if (gtdModule) {
          try {
            // Create child for this dispatch (parent already created above)
            if (orchestrationParentId) {
              gtdItem = await gtdModule.createDispatchChild({
                parentId: orchestrationParentId,
                content: input.task.slice(0, 200),
                assignedAgent: input.agent,
                assignedTo: input.agent,
                createdBy: effectiveCoordinatorAgent,
                dispatchEnvelopeId: specEnvelope.id,
              });
              // ELLIE-1152: Track last dispatch child for question parenting.
              // KNOWN LIMITATION: When multiple agents are dispatched in parallel,
              // lastDispatchChildId is nondeterministic — it will be whichever
              // Promise resolves last. The correct fix would be a Map<agent, childId>
              // so questions can be parented to the specific agent's child item.
              // For now, this is acceptable because ask_user questions reference
              // the orchestration parent as fallback when the specific child isn't known.
              if (gtdItem) lastDispatchChildId = gtdItem.id;
            }
          } catch (err) {
            logger.warn("GTD dispatch tracking failed", { error: err instanceof Error ? err.message : String(err) });
          }
        }

        try {
          const specResult = await deps.callSpecialist(
            input.agent,
            input.task,
            input.context,
            input.timeout_ms
          );

          // Aggregate specialist cost into session total
          specialistCostUsd += specResult.cost_usd;

          const completed = completeEnvelope(specEnvelope, {
            tokens_in: specResult.tokens_used,
            tokens_out: 0,
          });
          // Override envelope cost with actual CLI-reported cost when available
          if (specResult.cost_usd > 0) {
            completed.cost_usd = specResult.cost_usd;
          }
          envelopes.push(completed);
          try { await deps.logEnvelope(completed); } catch { /* best-effort */ }

          // ELLIE-1152: Update GTD item with specialist result
          if (gtdItem && gtdModule) {
            try {
              const gtdStatus = specResult.status === "completed" ? "done" : "failed";
              await gtdModule.updateItemStatus(gtdItem.id, gtdStatus, { output_preview: specResult.output?.slice(0, 500) });
            } catch (err) {
              logger.warn("GTD status update failed", { itemId: gtdItem.id, error: err instanceof Error ? err.message : String(err) });
            }
          }

          // DEPRECATED: Remove after dashboard migrates to dispatch_event (ELLIE-1308)
          // ELLIE-1099: Send spawn_announcement so dashboard shows completion
          try {
            await deps.sendEvent({
              type: "spawn_announcement",
              spawnId: specEnvelope.id,
              agent: input.agent,
              status: specResult.status === "error" ? "failed" : "completed",
              durationSec: Math.round(specResult.duration_ms / 1000),
              costCents: Math.round(completed.cost_usd * 100),
              resultPreview: specResult.status === "error"
                ? (specResult.error || "Unknown error")
                : specResult.output.slice(0, 300),
              error: specResult.error || null,
              ts: Date.now(),
            });
          } catch { /* best-effort */ }

          // Unified dispatch event (ELLIE-1308)
          emitDispatchEvent(specEnvelope.id, specResult.status === "error" ? "failed" : "completed", {
            agent: input.agent,
            title: input.task.slice(0, 200),
            work_item_id: workItemId,
            dispatch_type: "single",
            duration_ms: specResult.duration_ms,
            cost_usd: completed.cost_usd,
          });

          // Write dispatch outcome (ELLIE-1309)
          writeOutcome({
            run_id: specEnvelope.id,
            agent: input.agent,
            work_item_id: workItemId,
            dispatch_type: "single",
            status: specResult.status === "error" ? "failed" : "completed",
            summary: specResult.output?.slice(0, 1000) || null,
            duration_ms: specResult.duration_ms,
            tokens_in: specResult.tokens_used,
            tokens_out: 0,
            cost_usd: completed.cost_usd,
          });

          if (specResult.status === "error") {
            return {
              toolId,
              result: JSON.stringify({
                status: "error",
                agent: input.agent,
                error: specResult.error || "Unknown specialist error",
              }),
            };
          }

          // ELLIE-1317: Check for queued context from Dave — auto-redispatch if present
          try {
            const coordSessionId = `coordinator-${Date.now().toString(36)}`;
            const queuedMessages = await checkQueuedContext(coordSessionId, input.agent);
            if (queuedMessages.length > 0) {
              logger.info("Queued context found — auto-redispatching", { agent: input.agent, messageCount: queuedMessages.length });
              await clearQueuedContext(coordSessionId, input.agent);
              const redispatchTask = `Continue your previous work. Here are additional instructions from Dave that came in while you were working:\n\n${queuedMessages.map(m => `- ${m}`).join("\n")}\n\nYour previous result:\n${specResult.output?.slice(0, 2000) || "No output"}`;
              const redispatchResult = await deps.callSpecialist(input.agent, redispatchTask, input.context, input.timeout_ms);
              // Use the redispatch output instead
              return { toolId, result: redispatchResult.output || specResult.output };
            }
          } catch (err) {
            logger.warn("Queued context check failed — using original result", { agent: input.agent, error: err instanceof Error ? err.message : String(err) });
          }

          return {
            toolId,
            result: JSON.stringify({
              status: "completed",
              agent: input.agent,
              output: specResult.output,
            }),
          };
        } catch (err) {
          const failed = failEnvelope(specEnvelope, err instanceof Error ? err.message : String(err));
          envelopes.push(failed);
          try { await deps.logEnvelope(failed); } catch { /* best-effort */ }

          return {
            toolId,
            result: JSON.stringify({
              status: "error",
              agent: input.agent,
              error: err instanceof Error ? err.message : String(err),
            }),
          };
        }
      });

      const dispatchResults = await Promise.all(dispatchPromises);
      for (const { toolId, result } of dispatchResults) {
        ctx.addToolResult(toolId, result ?? "No output returned.");
      }
    }

    // Run other tools sequentially
    for (const tool of otherCalls) {
      const toolId = tool.id as string;
      const toolName = tool.name as string;

      try {
        const result = await handleTool(toolName, tool.input as Record<string, unknown>, channel, deps, opts.registry);
        ctx.addToolResult(toolId, result ?? "OK");
      } catch (err) {
        ctx.addToolResult(toolId, JSON.stringify({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    }

    // 4g. Check context pressure — compact if needed
    const pressure = ctx.getPressure();
    if (pressure === "critical") {
      const summary = await deps.getWorkingMemorySummary();
      ctx.rebuildFromSummary(summary);
      logger.warn("Context rebuilt from working memory", { iteration });

      // ELLIE-1273: Recover dispatch state from GTD after compaction via gtd-recovery module
      void rebuildDispatchStateFromGTD(
        channel,
        orchestrationParentId,
        deps.updateWorkingMemory,
      );
    } else if (pressure === "hot" || pressure === "warm") {
      ctx.compact(pressure);
      logger.info("Context compacted", { pressure, iteration });
    }
  }

  // If we hit maxIterations without breaking
  if (!response && loopIterations >= effectiveMaxIterations) {
    hitSafetyRail = true;
    response = "I've reached the maximum number of iterations for this request. Here's where things stand — please send a follow-up to continue.";
  }

  // Finalize coordinator envelope
  const finalEnvelope = completeEnvelope(coordEnvelope, {
    tokens_in: totalTokensIn,
    tokens_out: totalTokensOut,
    model: effectiveModel,
  });
  envelopes[0] = finalEnvelope;
  try { await deps.logEnvelope(finalEnvelope); } catch { /* best-effort */ }

  const durationMs = Date.now() - startTime;
  const totalCostUsd = computeCost(effectiveModel, totalTokensIn, totalTokensOut) + specialistCostUsd;

  return {
    response,
    loopIterations,
    envelopes,
    totalTokensIn,
    totalTokensOut,
    totalCostUsd,
    hitSafetyRail,
    durationMs,
  };
}

// ── Tool Handlers ───────────────────────────────────────────────────────────

async function handleTool(
  name: string,
  input: Record<string, unknown>,
  channel: string,
  deps: CoordinatorDeps,
  registry?: FoundationRegistry,
): Promise<string> {
  switch (name) {
    case "ask_user": {
      // ask_user is handled in the main loop (breaks the loop to pause for user input).
      // This case should not be reached — but handle defensively.
      const askInput = input as unknown as AskUserInput;
      const defQuestionId = `q-${Math.random().toString(16).slice(2, 10)}`;
      const defFormatted = formatQuestionMessage({
        agentName: "ellie",
        questionId: defQuestionId,
        question: askInput.question,
        whatINeed: askInput.what_i_need ?? "",
        decisionUnlocked: askInput.decision_unlocked ?? "",
        choices: askInput.choices,
      });
      await deps.sendMessage(channel, defFormatted);
      return JSON.stringify({ status: "paused", question: askInput.question });
    }

    case "update_user": {
      const updateInput = input as unknown as UpdateUserInput;
      await deps.sendMessage(updateInput.channel || channel, updateInput.message);
      return JSON.stringify({ status: "sent" });
    }

    case "read_context": {
      const readInput = input as unknown as ReadContextInput;
      let data: string;
      switch (readInput.source) {
        case "forest":
          data = await deps.readForest(readInput.query);
          break;
        case "plane":
          data = await deps.readPlane(readInput.query);
          break;
        case "memory":
          data = await deps.readMemory(readInput.query);
          break;
        case "sessions":
          data = await deps.readSessions(readInput.query);
          break;
        case "foundations": {
          if (registry) {
            const all = registry.listAll();
            const active = registry.getActive();
            data = `Active: ${active?.name || "none"}\nAvailable: ${all.map(f => `${f.name} (${f.agents.length} agents)`).join(", ")}`;
          } else {
            data = "Foundation registry not available.";
          }
          break;
        }
        default:
          data = `Unknown source: ${readInput.source}`;
      }
      return data;
    }

    case "invoke_recipe": {
      const recipeInput = input as unknown as InvokeRecipeInput;
      return await executeRecipe(recipeInput, channel, deps, registry);
    }

    case "start_overnight": {
      const { startOvernightSession } = await import("./overnight/scheduler.ts");
      try {
        const { sessionId, endsAt } = await startOvernightSession({
          endTime: input.end_time as string | undefined,
          concurrency: input.concurrency as number | undefined,
        });
        const endsAtStr = endsAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
        return JSON.stringify({ result: `Overnight session started (ID: ${sessionId}). I'll work through the scheduled GTD tasks until ${endsAtStr}. Check /overnight on the dashboard in the morning for results.` });
      } catch (err) {
        return JSON.stringify({ result: `Failed to start overnight session: ${(err as Error).message}` });
      }
    }

    default:
      return JSON.stringify({ status: "error", error: `Unknown tool: ${name}` });
  }
}

// ── Messages API Caller ─────────────────────────────────────────────────────

async function callMessagesAPI(
  client: Anthropic,
  opts: {
    model: string;
    systemPrompt: string;
    messages: Anthropic.MessageParam[];
  },
): Promise<Anthropic.Message> {
  return client.messages.create({
    model: opts.model,
    max_tokens: 4096,
    system: opts.systemPrompt,
    messages: opts.messages,
    tools: COORDINATOR_TOOL_DEFINITIONS,
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractText(content: Array<Record<string, unknown>>): string {
  const textBlocks = content.filter((b) => b.type === "text");
  return textBlocks.map((b) => b.text as string).join("\n");
}

function isRateLimitError(err: unknown): boolean {
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Error && err.message.includes("rate_limit")) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Recipe Execution (ELLIE-1102) ──────────────────────────────────────────

/**
 * Execute a coordination recipe using the coordinator's own dispatch capabilities.
 * Pipeline and fan-out patterns are executed directly by dispatching agents.
 * This avoids the heavy OrchestratorDeps wiring of the legacy formation system.
 */
async function executeRecipe(
  recipeInput: InvokeRecipeInput,
  channel: string,
  deps: CoordinatorDeps,
  registry?: FoundationRegistry,
): Promise<string> {
  // Find the recipe in the active foundation
  const recipes = registry?.getRecipes() ?? [];
  const recipe = recipes.find(r => r.name === recipeInput.recipe_name);

  if (!recipe) {
    const available = recipes.map(r => r.name).join(", ") || "none";
    return JSON.stringify({
      status: "error",
      error: `Recipe "${recipeInput.recipe_name}" not found. Available: ${available}`,
    });
  }

  const agents = recipeInput.agents_override ?? recipe.steps ?? recipe.agents ?? [];
  if (agents.length === 0) {
    return JSON.stringify({ status: "error", error: `Recipe "${recipe.name}" has no agents defined.` });
  }

  const inputText = typeof recipeInput.input === "string" ? recipeInput.input : JSON.stringify(recipeInput.input);
  logger.info("Executing recipe", { name: recipe.name, pattern: recipe.pattern, agents });

  // DEPRECATED: Remove after dashboard migrates to dispatch_event (ELLIE-1308)
  // Notify UI
  try {
    await deps.sendEvent({
      type: "spawn_status",
      spawnId: `recipe-${recipe.name}-${Date.now()}`,
      agent: "ellie",
      task: `Running recipe: ${recipe.name} (${recipe.pattern}) with ${agents.join(", ")}`,
      status: "running",
      ts: Date.now(),
    });
  } catch { /* best-effort */ }

  const startTime = Date.now();
  const agentOutputs: Array<{ agent: string; output: string; duration_ms: number }> = [];

  try {
    switch (recipe.pattern) {
      case "pipeline": {
        // Sequential: each agent receives the input + prior agent's output
        let runningContext = inputText;
        for (const agent of agents) {
          const result = await deps.callSpecialist(
            agent,
            `${inputText}\n\nPrior context from pipeline:\n${runningContext}`,
          );
          agentOutputs.push({ agent, output: result.output, duration_ms: result.duration_ms });
          runningContext = result.output; // Feed forward
          if (result.status === "error") {
            return JSON.stringify({
              status: "error",
              error: `Pipeline failed at ${agent}: ${result.error}`,
              agentOutputs,
            });
          }
        }
        break;
      }

      case "fan-out": {
        // Parallel: all agents get the same input, results collected
        const results = await Promise.all(
          agents.map(agent => deps.callSpecialist(agent, inputText))
        );
        for (let i = 0; i < agents.length; i++) {
          agentOutputs.push({
            agent: agents[i],
            output: results[i].output,
            duration_ms: results[i].duration_ms,
          });
        }
        break;
      }

      case "debate": {
        // Alternating rounds: each agent responds to the prior, 2 rounds
        let debate = inputText;
        for (let round = 0; round < 2; round++) {
          for (const agent of agents) {
            const result = await deps.callSpecialist(
              agent,
              `Round ${round + 1} of debate.\n\nTopic: ${inputText}\n\nDiscussion so far:\n${debate}`,
            );
            debate += `\n\n**${agent}** (round ${round + 1}):\n${result.output}`;
            agentOutputs.push({ agent, output: result.output, duration_ms: result.duration_ms });
          }
        }
        break;
      }

      case "round-table": {
        // 4-phase: convene → discuss (fan-out) → converge → deliver
        // Simplified version — uses the coordinator's dispatch rather than the legacy orchestrator
        const convener = agents[0];

        // Phase 1: Convene
        const conveneResult = await deps.callSpecialist(convener,
          `CONVENE PHASE: Analyze this request and identify the key dimensions to discuss.\n\n${inputText}`);
        agentOutputs.push({ agent: convener, output: conveneResult.output, duration_ms: conveneResult.duration_ms });

        // Phase 2: Discuss (fan-out to all agents)
        const discussResults = await Promise.all(
          agents.map(agent => deps.callSpecialist(agent,
            `DISCUSS PHASE: Share your perspective on this topic.\n\nTopic: ${inputText}\n\nConvene analysis:\n${conveneResult.output}`))
        );
        for (let i = 0; i < agents.length; i++) {
          agentOutputs.push({ agent: agents[i], output: discussResults[i].output, duration_ms: discussResults[i].duration_ms });
        }

        // Phase 3: Converge
        const allDiscussion = discussResults.map((r, i) => `**${agents[i]}:** ${r.output}`).join("\n\n");
        const convergeResult = await deps.callSpecialist(convener,
          `CONVERGE PHASE: Synthesize agreements, disagreements, and priorities from the discussion.\n\n${allDiscussion}`);
        agentOutputs.push({ agent: convener, output: convergeResult.output, duration_ms: convergeResult.duration_ms });

        // Phase 4: Deliver
        const deliverResult = await deps.callSpecialist(convener,
          `DELIVER PHASE: Produce the final polished deliverable based on the convergence.\n\n${convergeResult.output}`);
        agentOutputs.push({ agent: convener, output: deliverResult.output, duration_ms: deliverResult.duration_ms });
        break;
      }

      default:
        return JSON.stringify({ status: "error", error: `Unknown recipe pattern: ${recipe.pattern}` });
    }
  } catch (err) {
    return JSON.stringify({
      status: "error",
      error: `Recipe execution failed: ${err instanceof Error ? err.message : String(err)}`,
      agentOutputs,
    });
  }

  const durationMs = Date.now() - startTime;
  logger.info("Recipe complete", { name: recipe.name, pattern: recipe.pattern, agents: agentOutputs.length, durationMs });

  // DEPRECATED: Remove after dashboard migrates to dispatch_event (ELLIE-1308)
  // Notify UI of completion
  try {
    await deps.sendEvent({
      type: "spawn_announcement",
      spawnId: `recipe-${recipe.name}-${startTime}`,
      agent: "ellie",
      status: "completed",
      durationSec: Math.round(durationMs / 1000),
      resultPreview: `Recipe ${recipe.name} completed with ${agentOutputs.length} agent contributions`,
      ts: Date.now(),
    });
  } catch { /* best-effort */ }

  return JSON.stringify({
    status: "completed",
    recipe: recipe.name,
    pattern: recipe.pattern,
    synthesis: agentOutputs[agentOutputs.length - 1]?.output ?? "",
    agentOutputs: agentOutputs.map(o => ({ agent: o.agent, output: o.output.slice(0, 500), duration_ms: o.duration_ms })),
    duration_ms: durationMs,
  });
}

// ── buildCoordinatorDeps ────────────────────────────────────────────────────

/**
 * Bridge abstract CoordinatorDeps to actual relay infrastructure.
 * Stub for now — other tasks will fill in concrete implementations.
 */
export function buildCoordinatorDeps(opts: {
  sessionId: string;
  channel: string;
  sendFn: (channel: string, message: string) => Promise<void>;
  sendEventFn?: (event: Record<string, unknown>) => Promise<void>;  // ELLIE-1099
  forestReadFn: (query: string) => Promise<string>;
  planeReadFn?: (query: string) => Promise<string>;
  registry?: FoundationRegistry;
  coordinatorAgent?: string;
}): CoordinatorDeps {
  const { sessionId, channel, sendFn, forestReadFn } = opts;
  const coordAgent = opts.coordinatorAgent ?? "max";

  // Default Plane reader — uses the existing plane.ts API
  const defaultPlaneRead = async (query: string): Promise<string> => {
    const { isPlaneConfigured, fetchWorkItemDetails, listOpenIssues } = await import("./plane.ts");
    if (!isPlaneConfigured()) return "Plane is not configured.";

    // If query looks like a ticket ID (e.g. "ELLIE-123"), fetch that specific ticket
    const ticketMatch = query.match(/([A-Z]+-\d+)/);
    if (ticketMatch) {
      const details = await fetchWorkItemDetails(ticketMatch[1]);
      if (details) {
        return `${ticketMatch[1]}: ${details.name}\nPriority: ${details.priority}\nState: ${(details.state as string) || "unknown"}\n${details.description ? `Description: ${details.description.slice(0, 500)}` : ""}`;
      }
      return `Could not find ticket ${ticketMatch[1]}.`;
    }

    // Otherwise list open issues
    const issues = await listOpenIssues("ELLIE", 15);
    if (issues.length === 0) return "No open issues found.";
    return `Open ELLIE issues (${issues.length}):\n${issues.map(i => `- ELLIE-${i.sequenceId}: ${i.name} [${i.priority}]`).join("\n")}`;
  };

  const planeReadFn = opts.planeReadFn ?? defaultPlaneRead;

  return {
    callSpecialist: async (agent: string, task: string, context?: string, timeoutMs?: number) => {
      const { spawnClaudeStreaming } = await import("./claude-cli.ts");
      const { getAllowedToolsForCLI } = await import("./tool-access-control.ts");

      // Generate a dispatch ID for correlating tool call events to this agent
      const spawnId = `dsp_${Date.now().toString(36)}`;

      // Look up the agent's tool categories from the known roster
      const AGENT_TOOLS: Record<string, string[]> = {
        general: ["forest_bridge", "plane_lookup", "google_workspace", "web_search", "memory_extraction", "agent_router"],
        james: ["read", "write", "edit", "glob", "grep", "bash_builds", "bash_tests", "systemctl", "plane_mcp", "forest_bridge_read", "forest_bridge_write", "git", "supabase_mcp", "psql_forest"],
        kate: ["brave_search", "forest_bridge", "qmd_search", "google_workspace", "grep_glob_codebase", "memory_extraction"],
        alan: ["brave_web_search", "forest_bridge_read", "forest_bridge_write", "qmd_search", "plane_mcp", "miro", "memory_extraction"],
        brian: ["read", "glob", "grep", "forest_bridge_read", "forest_bridge_write", "plane_mcp", "bash_tests", "bash_type_checks"],
        amy: ["google_workspace", "forest_bridge_read", "qmd_search", "brave_web_search", "memory_extraction", "agentmail"],
        marcus: ["plane_mcp", "forest_bridge_read", "forest_bridge_write", "memory_extraction", "transaction_import", "receipt_parsing"],
        jason: ["bash_systemctl", "bash_journalctl", "bash_process_mgmt", "health_endpoint_checks", "log_analysis", "forest_bridge_read", "forest_bridge_write", "plane_mcp", "github_mcp", "telegram", "google_chat"],
        ellie: ["forest_bridge_read", "forest_bridge_write", "plane_mcp", "memory_extraction", "qmd_search", "brave_web_search", "google_workspace"],
      };

      const registryTools = opts.registry?.getAgentTools(agent);
      const agentToolCategories = (registryTools && registryTools.length > 0)
        ? registryTools
        : (AGENT_TOOLS[agent] ?? AGENT_TOOLS["general"]);
      const allowedTools = getAllowedToolsForCLI(agentToolCategories, agent);

      // [MAX] When dispatching to Ellie, prepend her soul so her personality
      // frames the response. Other specialists are tools — they don't need soul.
      let prompt = context ? `${task}\n\nContext:\n${context}` : task;
      if (agent === "ellie") {
        try {
          const { getCachedRiverDoc } = await import("./prompt-builder.ts");
          const soul = getCachedRiverDoc("soul");
          if (soul) {
            prompt = `# Ellie Soul\n${soul}\n---\n\nYou are Ellie, Dave's friend and partner. Respond to Dave in your voice — warm, conversational, using "we" framing. You're not an assistant completing a task, you're a partner in the work.\n\n${prompt}`;
          }
        } catch { /* soul unavailable — proceed without */ }
      }
      const start = Date.now();
      try {
        const result = await spawnClaudeStreaming(prompt, {
          timeoutMs,
          allowedTools,
          onToolUse: (toolName, toolInput) => {
            // Emit agent_tool_call event so dashboard can show real-time tool activity
            try {
              opts.sendEventFn?.({
                type: "agent_tool_call",
                spawnId,
                agent,
                tool: toolName,
                input: toolInput,
                status: "running",
                ts: Date.now(),
              });
            } catch { /* best-effort */ }
          },
          onToolResult: (toolName, durationMs) => {
            // Emit tool completion event
            try {
              opts.sendEventFn?.({
                type: "agent_tool_call",
                spawnId,
                agent,
                tool: toolName,
                status: "done",
                durationMs,
                ts: Date.now(),
              });
            } catch { /* best-effort */ }
          },
        });

        return {
          agent,
          status: (result.isError ? "error" : "completed") as "completed" | "error",
          output: result.output,
          cost_usd: result.costUsd,
          tokens_used: 0, // Not available from CLI stream output
          duration_ms: Date.now() - start,
        };
      } catch (err) {
        return {
          agent,
          status: "error" as const,
          output: "",
          error: err instanceof Error ? err.message : String(err),
          cost_usd: 0,
          tokens_used: 0,
          duration_ms: Date.now() - start,
        };
      }
    },

    sendMessage: sendFn,
    sendEvent: opts.sendEventFn ?? (async () => {}),  // ELLIE-1099: no-op if not provided
    readForest: forestReadFn,
    readPlane: planeReadFn,

    readMemory: async (query: string) => {
      const { readWorkingMemory } = await import("./working-memory.ts");
      const record = await readWorkingMemory({ session_id: sessionId, agent: coordAgent });
      return record ? JSON.stringify(record.sections) : "No working memory found.";
    },

    readSessions: async (_query: string) => {
      try {
        const { getRelayDeps } = await import("./relay-deps.ts");
        const { supabase } = getRelayDeps();
        if (!supabase) return "No database connection.";
        const { data } = await supabase
          .from("agent_sessions")
          .select("agent_name, channel, is_active, created_at")
          .eq("is_active", true)
          .order("created_at", { ascending: false })
          .limit(10);
        if (!data || data.length === 0) return "No active sessions.";
        return `Active sessions:\n${data.map((s: Record<string, unknown>) => `- ${s.agent_name} on ${s.channel} (started ${s.created_at})`).join("\n")}`;
      } catch {
        return "Could not query sessions.";
      }
    },

    getWorkingMemorySummary: async () => {
      const { readWorkingMemory } = await import("./working-memory.ts");
      const record = await readWorkingMemory({ session_id: sessionId, agent: coordAgent });
      if (!record) return "No working memory available.";
      return Object.entries(record.sections)
        .filter(([, v]) => v)
        .map(([k, v]) => `## ${k}\n${v}`)
        .join("\n\n");
    },

    updateWorkingMemory: async (sections: Record<string, string>) => {
      const { updateWorkingMemory: update } = await import("./working-memory.ts");
      await update({ session_id: sessionId, agent: coordAgent, sections });
    },

    promoteToForest: async () => {
      try {
        const res = await fetch("http://localhost:3001/api/working-memory/promote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, agent: coordAgent }),
        });
        if (!res.ok) logger.warn("Promote to Forest returned non-OK", { status: res.status });
      } catch (err) {
        logger.warn("Failed to promote to Forest", { error: String(err) });
      }
    },

    logEnvelope: async (envelope: DispatchEnvelope) => {
      // Log envelope to coordinator's own tracking — don't use orchestration-ledger
      // since it expects UUIDs and our envelope IDs are dsp_ prefixed.
      // Envelope data is already tracked in the CoordinatorResult.envelopes array.
      logger.info("Dispatch envelope", {
        id: envelope.id,
        type: envelope.type,
        agent: envelope.agent,
        status: envelope.status,
        cost_usd: envelope.cost_usd,
        tokens_in: envelope.tokens_in,
        tokens_out: envelope.tokens_out,
        duration_ms: envelope.completed_at && envelope.started_at
          ? new Date(envelope.completed_at).getTime() - new Date(envelope.started_at).getTime()
          : 0,
      });
    },
  };
}
