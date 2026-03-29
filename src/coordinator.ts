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

const logger = log.child("coordinator");

// ── Types ───────────────────────────────────────────────────────────────────

export interface SpecialistResult {
  agent: string;
  status: "completed" | "error";
  output: string;
  error?: string;
  tokens_used: number;
  duration_ms: number;
}

export interface CoordinatorDeps {
  callSpecialist: (agent: string, task: string, context?: string, timeoutMs?: number) => Promise<SpecialistResult>;
  sendMessage: (channel: string, message: string) => Promise<void>;
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
  maxIterations?: number;
  sessionTimeoutMs?: number;
  costCapUsd?: number;
  workItemId?: string;
  _testResponses?: Array<{
    stop_reason: string;
    content: Array<Record<string, unknown>>;
    usage: { input_tokens: number; output_tokens: number };
  }>;
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
}

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_SESSION_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
const DEFAULT_COST_CAP_USD = 2.0;
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
  const effectivePrompt = opts.registry?.getCoordinatorPrompt() ?? systemPrompt;

  const startTime = Date.now();
  const isTestMode = !!_testResponses;
  let testResponseIdx = 0;

  // Build system prompt from base + roster + foundation
  const fullSystemPrompt = [
    effectivePrompt,
    `\n## Agent Roster\nAvailable specialists: ${effectiveRoster.join(", ")}`,
    `\n## Foundation\n${foundation}`,
  ].join("\n");

  // 1. Create coordinator context
  const ctx = new CoordinatorContext({
    systemPrompt: fullSystemPrompt,
    maxTokens: MAX_CONTEXT_TOKENS,
  });

  // 2. Create coordinator envelope
  const coordEnvelope = createEnvelope({
    type: "coordinator",
    agent: "ellie",
    foundation,
    model: effectiveModel,
    work_item_id: workItemId,
  });

  const envelopes: DispatchEnvelope[] = [coordEnvelope];

  // 3. Add user message
  ctx.addUserMessage(message);

  // Tracking
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let hitSafetyRail = false;
  let response = "";
  let loopIterations = 0;

  // Anthropic client (only created if not in test mode)
  let client: Anthropic | null = null;
  if (!isTestMode) {
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

    // Check cost cap
    const currentCost = computeCost(effectiveModel, totalTokensIn, totalTokensOut);
    if (currentCost > effectiveCostCap) {
      hitSafetyRail = true;
      response = "I've reached the cost limit for this session. Here's what I've accomplished so far.";
      logger.warn("Cost cap reached", { iteration, cost: currentCost, cap: effectiveCostCap });
      break;
    }

    // 4b. Call Messages API (or use test responses)
    let apiResponse: {
      stop_reason: string;
      content: Array<Record<string, unknown>>;
      usage: { input_tokens: number; output_tokens: number };
    };

    if (isTestMode) {
      if (testResponseIdx >= _testResponses!.length) {
        hitSafetyRail = true;
        response = "Test responses exhausted.";
        break;
      }
      apiResponse = _testResponses![testResponseIdx++];
    } else {
      try {
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
      } catch (err: unknown) {
        // Rate limit: exponential backoff
        if (isRateLimitError(err)) {
          const backoff = Math.min(1000 * Math.pow(2, iteration), 30000);
          logger.warn("Rate limited, backing off", { backoff, iteration });
          await sleep(backoff);
          loopIterations--; // Retry this iteration
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
      } else if (tool.name === "dispatch_agent") {
        dispatchCalls.push(tool);
      } else {
        otherCalls.push(tool);
      }
    }

    if (shouldBreak) break;

    // Run all dispatch_agent calls in parallel
    if (dispatchCalls.length > 0) {
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

        try {
          const specResult = await deps.callSpecialist(
            input.agent,
            input.task,
            input.context,
            input.timeout_ms
          );

          const completed = completeEnvelope(specEnvelope, {
            tokens_in: specResult.tokens_used,
            tokens_out: 0,
          });
          envelopes.push(completed);
          try { await deps.logEnvelope(completed); } catch { /* best-effort */ }

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
        const result = await handleTool(toolName, tool.input as Record<string, unknown>, channel, deps);
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
  const totalCostUsd = computeCost(effectiveModel, totalTokensIn, totalTokensOut);

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
): Promise<string> {
  switch (name) {
    case "ask_user": {
      const askInput = input as unknown as AskUserInput;
      // Send the question but return a placeholder (full implementation in Task 5)
      await deps.sendMessage(channel, askInput.question);
      return JSON.stringify({
        status: "sent",
        note: "Question sent. User response will arrive asynchronously.",
      });
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
        default:
          data = `Unknown source: ${readInput.source}`;
      }
      return data;
    }

    case "invoke_recipe": {
      const _recipeInput = input as unknown as InvokeRecipeInput;
      return JSON.stringify({
        status: "not_available",
        note: "Recipe invocation is not yet available (Phase 2).",
      });
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

// ── buildCoordinatorDeps ────────────────────────────────────────────────────

/**
 * Bridge abstract CoordinatorDeps to actual relay infrastructure.
 * Stub for now — other tasks will fill in concrete implementations.
 */
export function buildCoordinatorDeps(opts: {
  sessionId: string;
  channel: string;
  sendFn: (channel: string, message: string) => Promise<void>;
  forestReadFn: (query: string) => Promise<string>;
  planeReadFn?: (query: string) => Promise<string>;
  registry?: FoundationRegistry;
}): CoordinatorDeps {
  const { sessionId, channel, sendFn, forestReadFn } = opts;

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
      const { callClaude } = await import("./claude-cli.ts");
      const { getAllowedToolsForCLI } = await import("./tool-access-control.ts");

      // Look up the agent's tool categories from the known roster
      const AGENT_TOOLS: Record<string, string[]> = {
        general: ["forest_bridge", "plane_lookup", "google_workspace", "web_search", "memory_extraction", "agent_router"],
        james: ["read", "write", "edit", "glob", "grep", "bash_builds", "bash_tests", "systemctl", "plane_mcp", "forest_bridge_read", "forest_bridge_write", "git", "supabase_mcp", "psql_forest"],
        kate: ["brave_search", "forest_bridge", "qmd_search", "google_workspace", "grep_glob_codebase", "memory_extraction"],
        alan: ["brave_web_search", "forest_bridge_read", "forest_bridge_write", "qmd_search", "plane_mcp", "miro", "memory_extraction"],
        brian: ["read", "glob", "grep", "forest_bridge_read", "forest_bridge_write", "plane_mcp", "bash_tests", "bash_type_checks"],
        amy: ["google_workspace", "forest_bridge_read", "qmd_search", "brave_web_search", "memory_extraction"],
        marcus: ["plane_mcp", "forest_bridge_read", "forest_bridge_write", "memory_extraction", "transaction_import", "receipt_parsing"],
        jason: ["bash_systemctl", "bash_journalctl", "bash_process_mgmt", "health_endpoint_checks", "log_analysis", "forest_bridge_read", "forest_bridge_write", "plane_mcp", "github_mcp", "telegram", "google_chat"],
      };

      const registryTools = opts.registry?.getAgentTools(agent);
      const agentToolCategories = (registryTools && registryTools.length > 0)
        ? registryTools
        : (AGENT_TOOLS[agent] ?? AGENT_TOOLS["general"]);
      const allowedTools = getAllowedToolsForCLI(agentToolCategories, agent);

      const prompt = context ? `${task}\n\nContext:\n${context}` : task;
      const start = Date.now();
      try {
        const output = await callClaude(prompt, { timeoutMs, allowedTools });
        return {
          agent,
          status: "completed" as const,
          output,
          tokens_used: 0, // CLI doesn't report tokens
          duration_ms: Date.now() - start,
        };
      } catch (err) {
        return {
          agent,
          status: "error" as const,
          output: "",
          error: err instanceof Error ? err.message : String(err),
          tokens_used: 0,
          duration_ms: Date.now() - start,
        };
      }
    },

    sendMessage: sendFn,
    readForest: forestReadFn,
    readPlane: planeReadFn,

    readMemory: async (query: string) => {
      const { readWorkingMemory } = await import("./working-memory.ts");
      const record = await readWorkingMemory({ session_id: sessionId, agent: "ellie" });
      return record ? JSON.stringify(record.sections) : "No working memory found.";
    },

    readSessions: async (_query: string) => {
      return "Sessions query not yet implemented.";
    },

    getWorkingMemorySummary: async () => {
      const { readWorkingMemory } = await import("./working-memory.ts");
      const record = await readWorkingMemory({ session_id: sessionId, agent: "ellie" });
      if (!record) return "No working memory available.";
      return Object.entries(record.sections)
        .filter(([, v]) => v)
        .map(([k, v]) => `## ${k}\n${v}`)
        .join("\n\n");
    },

    updateWorkingMemory: async (sections: Record<string, string>) => {
      const { updateWorkingMemory: update } = await import("./working-memory.ts");
      await update({ session_id: sessionId, agent: "ellie", sections });
    },

    promoteToForest: async () => {
      // Stub — will be wired to working memory promote endpoint
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
