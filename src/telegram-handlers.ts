/**
 * Telegram bot handlers — security middleware, message handlers, callback queries.
 *
 * Extracted from relay.ts — ELLIE-184 Phase 2.
 */

import { InputFile, type Bot, type Context } from "grammy";
import { writeFile, readFile, unlink } from "fs/promises";
import { join } from "path";
import { log } from "./logger.ts";
import {
  BOT_TOKEN, ALLOWED_USER_ID, GCHAT_SPACE_NOTIFY, UPLOADS_DIR,
  getContextDocket, clearContextCache,
} from "./relay-config.ts";
import {
  getActiveAgent, setActiveAgent,
  broadcastExtension, getRelayDeps, getNotifyCtx,
} from "./relay-state.ts";
import {
  resetTelegramIdleTimer, resetGchatIdleTimer, resetEllieChatIdleTimer,
} from "./relay-idle.ts";
import { transcribe } from "./transcribe.ts";
import { textToSpeechOgg } from "./tts.ts";
import {
  buildPrompt,
  runPostMessageAssessment,
  getPlanningMode,
  setPlanningMode,
  getArchetypeContext,
  getAgentArchetype,
  getPsyContext,
  getPhaseContext,
  getHealthContext,
  getLastBuildMetrics,
} from "./prompt-builder.ts";
import {
  callClaude,
  callClaudeWithTyping,
  callClaudeVoice,
  session,
} from "./claude-cli.ts";
import { withQueue } from "./message-queue.ts";
import { checkMessageRate, checkVoiceRate } from "./rate-limiter.ts";
import {
  saveMessage,
  sendResponse,
  sendWithApprovals,
} from "./message-sender.ts";
import {
  processMemoryIntents,
  getRelevantContext,
} from "./memory.ts";
import { searchElastic } from "./elasticsearch.ts";
import { getForestContext } from "./elasticsearch/context.ts";
import { acknowledgeChannel } from "./delivery.ts";
import {
  routeAndDispatch,
  syncResponse,
} from "./agent-router.ts";
import { getSkillSnapshot } from "./skills/index.ts";
import { getCreatureProfile } from "./creature-profile.ts";
import {
  formatForestMetrics,
  estimateTokens,
} from "./relay-utils.ts";
import {
  getAgentStructuredContext, getAgentMemoryContext, getMaxMemoriesForModel,
  getLiveForestContext,
} from "./context-sources.ts";
import {
  executeOrchestrated,
  PipelineStepError,
  type PipelineStep,
} from "./orchestrator.ts";
import {
  extractApprovalTags,
  getPendingAction,
  removePendingAction,
} from "./approval.ts";
import {
  isPlaneConfigured,
  fetchWorkItemDetails,
} from "./plane.ts";
import { extractPlaybookCommands, executePlaybookCommands, type PlaybookContext } from "./playbook.ts";
import { notify } from "./notification-policy.ts";
import {
  getOrCreateConversation,
  getConversationMessages,
} from "./conversations.ts";
import {
  getQueueContext,
  acknowledgeQueueItems,
} from "./api/agent-queue.ts";
import { detectAndCaptureCorrection } from "./correction-detector.ts";
import { detectAndLinkCalendarEvents } from "./calendar-linker.ts";
import { processMessageMode, isContextRefresh, detectMode } from "./context-mode.ts";
import { freshnessTracker, autoRefreshStaleSources } from "./context-freshness.ts";
import { checkGroundTruthConflicts, buildCrossChannelSection } from "./source-hierarchy.ts";
import { logVerificationTrail } from "./data-quality.ts";

const logger = log.child("telegram");

export function registerTelegramHandlers(bot: Bot): void {
  const { anthropic, supabase } = getRelayDeps();

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();

  // If ALLOWED_USER_ID is set, enforce it
  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
    console.log(`Unauthorized: ${userId}`);
    await ctx.reply("This bot is private.");
    return;
  }

  await next();
});

// callClaude, callClaudeWithTyping, callClaudeVoice, session management
// extracted to ./claude-cli.ts (ELLIE-205)

// Queue (enqueue, enqueueEllieChat, withQueue, getQueueStatus)
// extracted to ./message-queue.ts (ELLIE-206)

// ============================================================
// MESSAGE HANDLERS
// ============================================================

// Text messages
bot.on("message:text", withQueue(async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from?.id.toString() || "";
  console.log(`Message: ${text.substring(0, 50)}...`);

  // Rate limit check (ELLIE-228)
  const rateLimited = checkMessageRate(userId, "telegram");
  if (rateLimited) { await ctx.reply(rateLimited); return; }

  await ctx.replyWithChatAction("typing");
  acknowledgeChannel("telegram"); // User responded — clear pending responses

  await saveMessage("user", text, undefined, "telegram", userId);
  broadcastExtension({ type: "message_in", channel: "telegram", preview: text.substring(0, 200) });

  // Correction detection + calendar linking (ELLIE-250)
  if (supabase) {
    const convId = await getOrCreateConversation(supabase, "telegram");
    if (convId) {
      // Correction detection — check if user is correcting last assistant response
      supabase.from("messages")
        .select("content")
        .eq("conversation_id", convId)
        .eq("role", "assistant")
        .order("created_at", { ascending: false })
        .limit(1)
        .single()
        .then(({ data }) => {
          if (data?.content) {
            detectAndCaptureCorrection(text, data.content, anthropic, "telegram", convId)
              .catch(err => logger.warn("Correction detection failed", err));
          }
        })
        .catch(() => {});

      // Calendar-conversation linking — detect event mentions
      detectAndLinkCalendarEvents(text, supabase, convId)
        .catch(err => logger.warn("Calendar linking failed", err));
    }
  }

  // Slash commands — direct responses, bypass Claude pipeline (ELLIE-113)
  if (text.startsWith("/search ")) {
    const query = text.slice(8).trim();
    if (!query) { await ctx.reply("Usage: /search <query>"); return; }
    try {
      const { searchForestSafe } = await import("./elasticsearch/search-forest.ts");
      const results = await searchForestSafe(query, { limit: 10 });
      await sendResponse(ctx, results || "No results found.");
    } catch (err) {
      logger.error("/search failed", err);
      await ctx.reply("Search failed — ES may be unavailable.");
    }
    return;
  }

  if (text === "/forest-metrics" || text.startsWith("/forest-metrics ")) {
    try {
      const { getForestMetricsSafe } = await import("./elasticsearch/search-forest.ts");
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const metrics = await getForestMetricsSafe({
        timeRange: { from: weekAgo.toISOString(), to: now.toISOString() },
      });
      await sendResponse(ctx, formatForestMetrics(metrics));
    } catch (err) {
      logger.error("/forest-metrics failed", err);
      await ctx.reply("Metrics failed — ES may be unavailable.");
    }
    return;
  }

  // /plan on|off — toggle planning mode
  const planMatch = text.match(/^\/plan\s+(on|off)$/i);
  if (planMatch) {
    setPlanningMode(planMatch[1].toLowerCase() === "on");
    const msg = getPlanningMode()
      ? "Planning mode ON — conversation will persist for up to 60 minutes of idle time."
      : "Planning mode OFF — reverting to 10-minute idle timeout.";
    console.log(`[planning] ${msg}`);
    await ctx.reply(msg);
    resetTelegramIdleTimer();
    resetGchatIdleTimer();
    resetEllieChatIdleTimer();
    broadcastExtension({ type: "planning_mode", active: getPlanningMode() });
    return;
  }

  // ELLIE:: user-typed commands — bypass classifier, execute directly
  const { cleanedText: userPlaybookClean, commands: userPlaybookCmds } = extractPlaybookCommands(text);
  if (userPlaybookCmds.length > 0) {
    console.log(`[telegram] ELLIE:: commands in user message: ${userPlaybookCmds.map(c => c.type).join(", ")}`);
    await ctx.reply(`Processing ${userPlaybookCmds.length} playbook command(s)...`);
    const pbCtx: PlaybookContext = { bot, supabase, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, channel: "telegram", callClaudeFn: callClaude, buildPromptFn: buildPrompt };
    executePlaybookCommands(userPlaybookCmds, pbCtx).catch(err => logger.error("Playbook command execution failed", err));
    return;
  }

  // Route message to appropriate agent via LLM classifier (falls back gracefully)
  const detectedWorkItem = text.match(/\b([A-Z]+-\d+)\b/)?.[1];

  // ELLIE-381: Pre-routing mode check — skill-only → road-runner override
  const preRouteDetection = detectMode(text);
  const skillOnlyOverride = preRouteDetection?.mode === "skill-only" ? "road-runner" : undefined;
  if (skillOnlyOverride) {
    console.log(`[routing] skill-only mode detected — routing to road-runner`);
  }

  const agentResult = await routeAndDispatch(supabase, text, "telegram", userId, detectedWorkItem, skillOnlyOverride);
  const effectiveText = agentResult?.route.strippedMessage || text;
  if (agentResult) {
    setActiveAgent("telegram", agentResult.dispatch.agent.name);
    // ELLIE-383: Include contextMode from pre-route detection in route broadcast
    broadcastExtension({ type: "route", channel: "telegram", agent: agentResult.dispatch.agent.name, mode: agentResult.route.execution_mode, confidence: agentResult.route.confidence, contextMode: preRouteDetection?.mode || undefined });

    // Dispatch confirmation — routed through notification policy (ELLIE-80)
    if (agentResult.dispatch.agent.name !== "general" && agentResult.dispatch.is_new) {
      const agentName = agentResult.dispatch.agent.name;
      notify(getNotifyCtx(), {
        event: "dispatch_confirm",
        workItemId: agentName,
        telegramMessage: `🤖 ${agentName} agent`,
        gchatMessage: `🤖 ${agentName} agent dispatched`,
      }).catch((err) => logger.error("Dispatch confirm notification failed", err));
    }
  }

  // Gather context: full conversation (primary) + docket + search (excluding current conversation) + structured + forest + agent memory + queue
  const activeAgent = getActiveAgent("telegram");
  const activeConvoId = await getOrCreateConversation(supabase!, "telegram") || undefined;

  // ── ELLIE-325: Message-level mode detection ──
  const convoKey = activeConvoId || "telegram-default";
  const { mode: contextMode, changed: modeChanged } = processMessageMode(convoKey, effectiveText);
  if (modeChanged) {
    console.log(`[context:mode] mode=${contextMode}`);
  }
  const [conversationContext, contextDocket, relevantContext, elasticContext, structuredContext, forestContext, agentMemory, queueContext, liveForest] = await Promise.all([
    activeConvoId && supabase ? getConversationMessages(supabase, activeConvoId) : Promise.resolve({ text: "", messageCount: 0, conversationId: "" }),
    getContextDocket(),
    getRelevantContext(supabase, effectiveText, "telegram", activeAgent, activeConvoId),
    searchElastic(effectiveText, { limit: 5, recencyBoost: true, channel: "telegram", sourceAgent: activeAgent, excludeConversationId: activeConvoId }),
    getAgentStructuredContext(supabase, activeAgent),
    getForestContext(effectiveText),
    getAgentMemoryContext(activeAgent, detectedWorkItem, getMaxMemoriesForModel(agentResult?.dispatch.agent.model)),
    agentResult?.dispatch.is_new ? getQueueContext(activeAgent) : Promise.resolve(""),
    getLiveForestContext(effectiveText),
  ]);
  const recentMessages = conversationContext.text;
  // Auto-acknowledge queue items on new session (fire-and-forget)
  if (agentResult?.dispatch.is_new && queueContext) {
    acknowledgeQueueItems(activeAgent).catch(() => {});
  }

  // ELLIE-327: Track section-level freshness for non-registry sources
  if (recentMessages) freshnessTracker.recordFetch("recent-messages", 0);
  if (queueContext) freshnessTracker.recordFetch("queue", 0);
  if (contextDocket) freshnessTracker.recordFetch("context-docket", 0);
  if (relevantContext || elasticContext || forestContext) freshnessTracker.recordFetch("search", 0);

  // ELLIE-327: Log mode config + freshness status
  freshnessTracker.logModeConfig(contextMode);
  freshnessTracker.logAllFreshness(contextMode);

  // ELLIE-327: Auto-refresh stale critical sources
  const { refreshed: tgRefreshed, results: tgRefreshResults } = await autoRefreshStaleSources(
    contextMode,
    {
      "structured-context": () => getAgentStructuredContext(supabase, activeAgent),
      "context-docket": () => { clearContextCache(); return getContextDocket(); },
      "agent-memory": async () => {
        const mem = await getAgentMemoryContext(activeAgent, detectedWorkItem, getMaxMemoriesForModel(agentResult?.dispatch.agent.model));
        return mem.memoryContext;
      },
      "forest-awareness": async () => {
        const lf = await getLiveForestContext(effectiveText);
        return lf.awareness;
      },
    },
  );

  // ELLIE-327: Apply auto-refresh results
  const tgStructured = tgRefreshResults["structured-context"] || structuredContext;
  const tgDocket = tgRefreshResults["context-docket"] || contextDocket;
  const tgForestAwareness = tgRefreshResults["forest-awareness"] || liveForest.awareness;
  const tgAgentMem = tgRefreshResults["agent-memory"] || agentMemory.memoryContext;

  // Detect work item mentions (ELLIE-5, EVE-3, etc.)
  let workItemContext = "";
  const workItemMatch = effectiveText.match(/\b([A-Z]+-\d+)\b/);
  const isWorkIntent = agentResult?.route.skill_name === "code_changes" ||
    agentResult?.route.skill_name === "code_review" ||
    agentResult?.route.skill_name === "debugging";
  if (workItemMatch && isPlaneConfigured()) {
    const wiStart = Date.now();
    const details = await fetchWorkItemDetails(workItemMatch[1]);
    const wiLatency = Date.now() - wiStart;
    if (details) {
      const label = isWorkIntent ? "ACTIVE WORK ITEM" : "REFERENCED WORK ITEM";
      workItemContext = `\n${label}: ${workItemMatch[1]}\n` +
        `Title: ${details.name}\n` +
        `Priority: ${details.priority}\n` +
        `Description: ${details.description}\n`;
      freshnessTracker.recordFetch("work-item", wiLatency);

      // ELLIE-328: Log verification trail for work item health check
      logVerificationTrail({
        channel: "telegram",
        agent: activeAgent || "general",
        conversation_id: activeConvoId,
        entries: [{
          claim: `ticket-state:${workItemMatch[1]}`,
          source: "plane",
          result: "confirmed",
          checked_value: details.state || details.priority,
          latency_ms: wiLatency,
        }],
        timestamp: new Date().toISOString(),
      }).catch(() => {}); // fire-and-forget
    }
  }

  // ── Multi-step execution branch (ELLIE-58) ──
  if (agentResult?.route.execution_mode !== "single" && agentResult?.route.skills?.length) {
    const execMode = agentResult.route.execution_mode;
    const steps: PipelineStep[] = agentResult.route.skills.map((s) => ({
      agent_name: s.agent,
      skill_name: s.skill !== "none" ? s.skill : undefined,
      instruction: s.instruction,
    }));

    const modeLabels: Record<string, string> = { pipeline: "Pipeline", "fan-out": "Fan-out", "critic-loop": "Critic loop" };
    const agentNames = [...new Set(steps.map((s) => s.agent_name))].join(" \u2192 ");
    await ctx.reply(`\u{1F504} ${modeLabels[execMode] || execMode}: ${agentNames} (${steps.length} steps)`);

    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4_000);

    broadcastExtension({ type: "pipeline_start", channel: "telegram", mode: execMode, steps: steps.length });
    try {
      const result = await executeOrchestrated(execMode, steps, effectiveText, {
        supabase,
        channel: "telegram",
        userId,
        anthropicClient: anthropic,
        onHeartbeat: () => { ctx.replyWithChatAction("typing").catch(() => {}); },
        contextDocket, relevantContext, elasticContext,
        structuredContext, recentMessages, workItemContext, forestContext,
        buildPromptFn: buildPrompt,
        callClaudeFn: callClaude,
      });

      clearInterval(typingInterval);

      const agentName = result.finalDispatch?.agent?.name || agentResult?.dispatch.agent.name || "general";
      const pipelineResponse = await processMemoryIntents(supabase, result.finalResponse, agentName, "shared", agentMemory.sessionIds);
      const { cleanedText: playbookClean, commands: playbookCommands } = extractPlaybookCommands(pipelineResponse);
      const cleanedPipelineResponse = await sendWithApprovals(ctx, playbookClean, session.sessionId, agentName);
      await saveMessage("assistant", cleanedPipelineResponse, undefined, "telegram", userId);
      runPostMessageAssessment(text, cleanedPipelineResponse, anthropic).catch(err => logger.error("Post-message assessment failed", err));
      broadcastExtension({ type: "pipeline_complete", channel: "telegram", mode: execMode, steps: result.stepResults.length, duration_ms: result.artifacts.total_duration_ms, cost_usd: result.artifacts.total_cost_usd });

      if (result.finalDispatch) {
        syncResponse(supabase, result.finalDispatch.session_id, cleanedPipelineResponse, {
          duration_ms: result.artifacts.total_duration_ms,
        }).catch(() => {});
      }

      // Fire playbook commands async (ELLIE:: tags)
      if (playbookCommands.length > 0) {
        const pbCtx: PlaybookContext = { bot, supabase, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, channel: "telegram", callClaudeFn: callClaude, buildPromptFn: buildPrompt };
        executePlaybookCommands(playbookCommands, pbCtx).catch(err => logger.error("Playbook command execution failed", err));
      }

      console.log(
        `[orchestrator] ${execMode}: ${result.stepResults.length} steps in ${result.artifacts.total_duration_ms}ms, ` +
        `$${result.artifacts.total_cost_usd.toFixed(4)}`,
      );
    } catch (err) {
      clearInterval(typingInterval);
      if (err instanceof PipelineStepError && err.partialOutput) {
        logger.error("Pipeline step failed, sending partial results", { stepIndex: err.stepIndex, errorType: err.errorType });
        const partialResponse = await processMemoryIntents(supabase, err.partialOutput, agentResult?.dispatch.agent.name || "general", "shared", agentMemory.sessionIds);
        await sendResponse(ctx, partialResponse + "\n\n(Execution incomplete \u2014 showing partial results.)");
        await saveMessage("assistant", partialResponse, undefined, "telegram", userId);
        runPostMessageAssessment(text, partialResponse, anthropic).catch(err2 => logger.error("Post-message assessment failed", err2));
      } else {
        logger.error("Multi-step failed, falling back to single agent", err);
        const fallbackPrompt = buildPrompt(
          effectiveText, contextDocket, relevantContext, elasticContext, "telegram",
          agentResult?.dispatch.agent ? { system_prompt: agentResult.dispatch.agent.system_prompt, name: agentResult.dispatch.agent.name, tools_enabled: agentResult.dispatch.agent.tools_enabled } : undefined,
          workItemContext, structuredContext, recentMessages,
          agentResult?.dispatch.skill_context,
          forestContext,
          agentMemory.memoryContext || undefined,
          agentMemory.sessionIds,
          await getAgentArchetype(agentResult?.dispatch.agent?.name),
          await getPsyContext(),
          await getPhaseContext(),
          await getHealthContext(),
          queueContext || undefined,
          liveForest.incidents || undefined,
          liveForest.awareness || undefined,
          (await getSkillSnapshot(getCreatureProfile(agentResult?.dispatch.agent?.name)?.allowed_skills)).prompt || undefined,
          contextMode,
        );
        const fallbackRaw = await callClaudeWithTyping(ctx, fallbackPrompt, { resume: true });
        const fallbackAgentName = agentResult?.dispatch.agent.name || "general";
        const fallbackResponse = await processMemoryIntents(supabase, fallbackRaw, fallbackAgentName, "shared", agentMemory.sessionIds);
        const cleaned = await sendWithApprovals(ctx, fallbackResponse, session.sessionId, fallbackAgentName);
        await saveMessage("assistant", cleaned, undefined, "telegram", userId);
        runPostMessageAssessment(text, cleaned, anthropic).catch(err2 => logger.error("Post-message assessment failed", err2));
      }
    }

    resetTelegramIdleTimer();
    return;
  }

  // ── Single-agent path (default) ──
  // ELLIE-250 Phase 3: Proactive conflict detection + cross-channel sync
  const tgContextSections = [
    { label: "structured-context", content: tgStructured || "" },
    { label: "context-docket", content: tgDocket || "" },
    { label: "work-item", content: workItemContext || "" },
    { label: "forest-awareness", content: tgForestAwareness || "" },
  ];
  const [tgGroundTruthConflicts, tgCrossChannel] = await Promise.all([
    checkGroundTruthConflicts(effectiveText, tgContextSections),
    buildCrossChannelSection(supabase, "telegram"),
  ]);

  const enrichedPrompt = buildPrompt(
    effectiveText, tgDocket, relevantContext, elasticContext, "telegram",
    agentResult?.dispatch.agent ? { system_prompt: agentResult.dispatch.agent.system_prompt, name: agentResult.dispatch.agent.name, tools_enabled: agentResult.dispatch.agent.tools_enabled } : undefined,
    workItemContext, tgStructured, recentMessages,
    agentResult?.dispatch.skill_context,
    forestContext,
    tgAgentMem || undefined,
    agentMemory.sessionIds,
    await getAgentArchetype(agentResult?.dispatch.agent?.name),
    await getPsyContext(),
    await getPhaseContext(),
    await getHealthContext(),
    queueContext || undefined,
    liveForest.incidents || undefined,
    tgForestAwareness || undefined,
    (await getSkillSnapshot(getCreatureProfile(agentResult?.dispatch.agent?.name)?.allowed_skills)).prompt || undefined,
    contextMode,
    tgRefreshed,
    undefined, // channelProfile (Telegram doesn't use channels yet)
    tgGroundTruthConflicts || undefined,
    tgCrossChannel || undefined,
  );

  // ── ELLIE-383: Context snapshot logging + extension broadcast ──
  const buildMetrics = getLastBuildMetrics();
  if (buildMetrics) {
    const top5 = [...buildMetrics.sections].sort((a, b) => b.tokens - a.tokens).slice(0, 5);
    console.log(
      `[context:snapshot] creature=${buildMetrics.creature || "general"} mode=${buildMetrics.mode || "default"} ` +
      `tokens=${buildMetrics.totalTokens} sections=${buildMetrics.sectionCount} budget=${buildMetrics.budget} ` +
      `top5=[${top5.map(s => `${s.label}:${s.tokens}`).join(", ")}]`
    );
    broadcastExtension({
      type: "context_snapshot",
      channel: "telegram",
      creature: buildMetrics.creature || "general",
      contextMode: buildMetrics.mode || "conversation",
      totalTokens: buildMetrics.totalTokens,
      sectionCount: buildMetrics.sectionCount,
      budget: buildMetrics.budget,
      top5: top5.map(s => ({ label: s.label, tokens: s.tokens })),
    });
  }

  const agentTools = agentResult?.dispatch.agent.tools_enabled;
  const agentModel = agentResult?.dispatch.agent.model;

  const startTime = Date.now();
  const rawResponse = await callClaudeWithTyping(ctx, enrichedPrompt, {
    resume: true,
    allowedTools: agentTools?.length ? agentTools : undefined,
    model: agentModel || undefined,
  });
  const durationMs = Date.now() - startTime;

  // Late-resolve sessionIds if not available at context-build time
  let effectiveSessionIds = agentMemory.sessionIds;
  if (!effectiveSessionIds && agentResult?.dispatch.agent.name) {
    try {
      const { default: forestSql } = await import('../../ellie-forest/src/db');
      const { getEntity } = await import('../../ellie-forest/src/index');
      const AGENT_ENTITY_MAP: Record<string, string> = { dev: "dev_agent", general: "general_agent" };
      const entityName = AGENT_ENTITY_MAP[agentResult.dispatch.agent.name] ?? agentResult.dispatch.agent.name;
      const entity = await getEntity(entityName);
      if (entity) {
        const [tree] = await forestSql<{ id: string; work_item_id: string | null }[]>`
          SELECT t.id, t.work_item_id FROM trees t
          JOIN creatures c ON c.tree_id = t.id
          WHERE t.type = 'work_session' AND t.state IN ('growing', 'dormant')
            AND t.last_activity > NOW() - INTERVAL '5 minutes' AND c.entity_id = ${entity.id}
          ORDER BY t.last_activity DESC LIMIT 1
        `;
        if (tree) {
          const [creature] = await forestSql<{ id: string }[]>`
            SELECT id FROM creatures WHERE tree_id = ${tree.id} AND entity_id = ${entity.id}
            ORDER BY created_at DESC LIMIT 1
          `;
          effectiveSessionIds = { tree_id: tree.id, creature_id: creature?.id, entity_id: entity.id, work_item_id: tree.work_item_id };
          console.log(`[telegram] Late-resolved sessionIds: tree=${tree.id.slice(0, 8)}`);
        }
      }
    } catch (err: unknown) {
      logger.warn("Late-resolve sessionIds failed", err);
    }
  }

  // Parse and save any memory intents, strip tags from response
  const response = await processMemoryIntents(supabase, rawResponse, agentResult?.dispatch.agent.name || "general", "shared", effectiveSessionIds);

  // Extract ELLIE:: playbook commands before sending to user
  const { cleanedText: playbookCleanedResponse, commands: tgPlaybookCommands } = extractPlaybookCommands(response);

  const cleanedResponse = await sendWithApprovals(ctx, playbookCleanedResponse, session.sessionId, agentResult?.dispatch.agent.name);

  await saveMessage("assistant", cleanedResponse, undefined, "telegram", userId);
  runPostMessageAssessment(text, cleanedResponse, anthropic).catch(err => logger.error("Post-message assessment failed", err));
  broadcastExtension({ type: "message_out", channel: "telegram", agent: agentResult?.dispatch.agent.name || "general", preview: cleanedResponse.substring(0, 200) });

  // Sync response to agent session (fire-and-forget)
  if (agentResult) {
    const syncResult = await syncResponse(supabase, agentResult.dispatch.session_id, cleanedResponse, {
      duration_ms: durationMs,
    });
    if (syncResult?.new_session_id) {
      await ctx.reply("\u21AA\uFE0F Handing off to another agent...");
    }
  }

  // Fire playbook commands async (ELLIE:: tags)
  if (tgPlaybookCommands.length > 0) {
    const pbCtx: PlaybookContext = { bot, supabase, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, channel: "telegram", callClaudeFn: callClaude, buildPromptFn: buildPrompt };
    executePlaybookCommands(tgPlaybookCommands, pbCtx).catch(err => logger.error("Playbook command execution failed", err));
  }

  resetTelegramIdleTimer();
}));

// Voice messages
bot.on("message:voice", withQueue(async (ctx) => {
  const voice = ctx.message.voice;
  console.log(`Voice message: ${voice.duration}s`);

  // Rate limit check — voice is more expensive (ELLIE-228)
  const userId = ctx.from?.id.toString() || "";
  const rateLimited = checkVoiceRate(userId);
  if (rateLimited) { await ctx.reply(rateLimited); return; }

  await ctx.replyWithChatAction("typing");

  if (!process.env.VOICE_PROVIDER) {
    await ctx.reply(
      "Voice transcription is not set up yet. " +
        "Run the setup again and choose a voice provider (Groq or local Whisper)."
    );
    return;
  }

  try {
    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());

    const transcription = await transcribe(buffer);
    if (!transcription) {
      await ctx.reply("Could not transcribe voice message.");
      return;
    }

    const voiceUserId = ctx.from?.id.toString() || "";
    await saveMessage("user", `[Voice ${voice.duration}s]: ${transcription}`, undefined, "telegram", voiceUserId);
    broadcastExtension({ type: "message_in", channel: "telegram", preview: `[Voice ${voice.duration}s]: ${transcription.substring(0, 150)}` });
    const voiceWorkItem = transcription.match(/\b([A-Z]+-\d+)\b/)?.[1];
    const voicePreRoute = detectMode(transcription);
    const voiceSkillOverride = voicePreRoute?.mode === "skill-only" ? "road-runner" : undefined;
    const agentResult = await routeAndDispatch(supabase, transcription, "telegram", voiceUserId, voiceWorkItem, voiceSkillOverride);
    const effectiveTranscription = agentResult?.route.strippedMessage || transcription;
    if (agentResult) {
      setActiveAgent("telegram", agentResult.dispatch.agent.name);
      // ELLIE-383: Include contextMode from pre-route detection in route broadcast
      broadcastExtension({ type: "route", channel: "telegram", agent: agentResult.dispatch.agent.name, mode: agentResult.route.execution_mode, contextMode: voicePreRoute?.mode || undefined });

      // Dispatch confirmation for voice (matches text handler)
      if (agentResult.dispatch.agent.name !== "general" && agentResult.dispatch.is_new) {
        const agentName = agentResult.dispatch.agent.name;
        notify(getNotifyCtx(), {
          event: "dispatch_confirm",
          workItemId: agentName,
          telegramMessage: `🤖 ${agentName} agent`,
          gchatMessage: `🤖 ${agentName} agent dispatched`,
        }).catch((err) => logger.error("Dispatch confirm notification failed", err));
      }
    }

    const voiceActiveAgent = getActiveAgent("telegram");
    const voiceConvoId = await getOrCreateConversation(supabase!, "telegram") || undefined;

    // ── ELLIE-325: Mode detection for voice messages ──
    const voiceConvoKey = voiceConvoId || "telegram-voice-default";
    const { mode: voiceContextMode, changed: voiceModeChanged } = processMessageMode(voiceConvoKey, effectiveTranscription);
    if (voiceModeChanged) {
      console.log(`[context:mode] mode=${voiceContextMode} channel=voice`);
    }

    const [voiceConvoContext, contextDocket, relevantContext, elasticContext, structuredContext, forestContext, agentMemory, voiceQueueContext, liveForest] = await Promise.all([
      voiceConvoId && supabase ? getConversationMessages(supabase, voiceConvoId) : Promise.resolve({ text: "", messageCount: 0, conversationId: "" }),
      getContextDocket(),
      getRelevantContext(supabase, effectiveTranscription, "telegram", voiceActiveAgent, voiceConvoId),
      searchElastic(effectiveTranscription, { limit: 5, recencyBoost: true, channel: "telegram", sourceAgent: voiceActiveAgent, excludeConversationId: voiceConvoId }),
      getAgentStructuredContext(supabase, voiceActiveAgent),
      getForestContext(effectiveTranscription),
      getAgentMemoryContext(voiceActiveAgent, voiceWorkItem, getMaxMemoriesForModel(agentResult?.dispatch.agent.model)),
      agentResult?.dispatch.is_new ? getQueueContext(voiceActiveAgent) : Promise.resolve(""),
      getLiveForestContext(effectiveTranscription),
    ]);
    const recentMessages = voiceConvoContext.text;
    if (agentResult?.dispatch.is_new && voiceQueueContext) {
      acknowledgeQueueItems(voiceActiveAgent).catch(() => {});
    }

    // ELLIE-327: Track section-level freshness for non-registry sources
    if (recentMessages) freshnessTracker.recordFetch("recent-messages", 0);
    if (voiceQueueContext) freshnessTracker.recordFetch("queue", 0);

    // ELLIE-327: Log mode config + freshness status
    freshnessTracker.logModeConfig(voiceContextMode);
    freshnessTracker.logAllFreshness(voiceContextMode);

    // ELLIE-327: Auto-refresh stale critical sources
    const { refreshed: voiceRefreshed, results: voiceRefreshResults } = await autoRefreshStaleSources(
      voiceContextMode,
      {
        "structured-context": () => getAgentStructuredContext(supabase, voiceActiveAgent),
        "context-docket": () => { clearContextCache(); return getContextDocket(); },
        "agent-memory": async () => {
          const mem = await getAgentMemoryContext(voiceActiveAgent, voiceWorkItem, getMaxMemoriesForModel(agentResult?.dispatch.agent.model));
          return mem.memoryContext;
        },
        "forest-awareness": async () => {
          const lf = await getLiveForestContext(effectiveTranscription);
          return lf.awareness;
        },
      },
    );

    // ── Voice multi-step branch (ELLIE-58) ──
    if (agentResult?.route.execution_mode !== "single" && agentResult?.route.skills?.length) {
      const execMode = agentResult.route.execution_mode;
      const steps: PipelineStep[] = agentResult.route.skills.map((s) => ({
        agent_name: s.agent,
        skill_name: s.skill !== "none" ? s.skill : undefined,
        instruction: s.instruction,
      }));

      const modeLabels: Record<string, string> = { pipeline: "Pipeline", "fan-out": "Fan-out", "critic-loop": "Critic loop" };
      const agentNames = [...new Set(steps.map((s) => s.agent_name))].join(" \u2192 ");
      await ctx.reply(`\u{1F504} ${modeLabels[execMode] || execMode}: ${agentNames} (${steps.length} steps)`);

      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction("typing").catch(() => {});
      }, 4_000);

      try {
        const result = await executeOrchestrated(execMode, steps, effectiveTranscription, {
          supabase,
          channel: "telegram",
          userId: voiceUserId,
          anthropicClient: anthropic,
          onHeartbeat: () => { ctx.replyWithChatAction("typing").catch(() => {}); },
          contextDocket, relevantContext, elasticContext,
          structuredContext, recentMessages, forestContext,
          buildPromptFn: buildPrompt,
          callClaudeFn: callClaude,
        });

        clearInterval(typingInterval);
        const voiceAgentName = result.finalDispatch?.agent?.name || agentResult?.dispatch.agent.name || "general";
        const pipelineResponse = await processMemoryIntents(supabase, result.finalResponse, voiceAgentName, "shared", agentMemory.sessionIds);
        const cleaned = await sendWithApprovals(ctx, pipelineResponse, session.sessionId, voiceAgentName);
        await saveMessage("assistant", cleaned, undefined, "telegram", voiceUserId);
        runPostMessageAssessment(transcription, cleaned, anthropic).catch(err => logger.error("Post-message assessment failed", err));

        if (result.finalDispatch) {
          syncResponse(supabase, result.finalDispatch.session_id, cleaned, {
            duration_ms: result.artifacts.total_duration_ms,
          }).catch(() => {});
        }

        console.log(
          `[orchestrator] Voice ${execMode}: ${result.stepResults.length} steps in ${result.artifacts.total_duration_ms}ms, $${result.artifacts.total_cost_usd.toFixed(4)}`,
        );
      } catch (err) {
        clearInterval(typingInterval);
        if (err instanceof PipelineStepError && err.partialOutput) {
          const partialResponse = await processMemoryIntents(supabase, err.partialOutput, agentResult?.dispatch.agent.name || "general", "shared", agentMemory.sessionIds);
          await sendResponse(ctx, partialResponse + "\n\n(Execution incomplete \u2014 showing partial results.)");
          await saveMessage("assistant", partialResponse, undefined, "telegram", voiceUserId);
          runPostMessageAssessment(transcription, partialResponse, anthropic).catch(err2 => logger.error("Post-message assessment failed", err2));
        } else {
          logger.error("Voice multi-step failed", err);
          await ctx.reply("Multi-step execution failed \u2014 processing as single request.");
          const fallbackPrompt = buildPrompt(
            `[Voice message transcribed]: ${effectiveTranscription}`,
            contextDocket, relevantContext, elasticContext, "telegram",
            agentResult?.dispatch.agent ? { system_prompt: agentResult.dispatch.agent.system_prompt, name: agentResult.dispatch.agent.name, tools_enabled: agentResult.dispatch.agent.tools_enabled } : undefined,
            undefined, structuredContext, recentMessages,
            agentResult?.dispatch.skill_context,
            forestContext,
            agentMemory.memoryContext || undefined,
            agentMemory.sessionIds,
            await getAgentArchetype(agentResult?.dispatch.agent?.name),
            await getPsyContext(),
            await getPhaseContext(),
            await getHealthContext(),
            voiceQueueContext || undefined,
            liveForest.incidents || undefined,
            liveForest.awareness || undefined,
            (await getSkillSnapshot(getCreatureProfile(agentResult?.dispatch.agent?.name)?.allowed_skills)).prompt || undefined,
            voiceContextMode,
          );
          const fallbackRaw = await callClaudeWithTyping(ctx, fallbackPrompt, { resume: true });
          const voiceFallbackAgent = agentResult?.dispatch.agent.name || "general";
          const fallbackResponse = await processMemoryIntents(supabase, fallbackRaw, voiceFallbackAgent, "shared", agentMemory.sessionIds);
          const cleaned = await sendWithApprovals(ctx, fallbackResponse, session.sessionId, voiceFallbackAgent);
          await saveMessage("assistant", cleaned, undefined, "telegram", voiceUserId);
          runPostMessageAssessment(transcription, cleaned, anthropic).catch(err2 => logger.error("Post-message assessment failed", err2));
        }
      }

      resetTelegramIdleTimer();
      return;
    }

    // ── Voice single-agent path (default) ──
    // ELLIE-327: Apply auto-refresh results
    const voiceStructured = voiceRefreshResults["structured-context"] || structuredContext;
    const voiceDocket = voiceRefreshResults["context-docket"] || contextDocket;
    const voiceForestAwareness = voiceRefreshResults["forest-awareness"] || liveForest.awareness;
    const voiceAgentMem = voiceRefreshResults["agent-memory"] || agentMemory.memoryContext;

    const enrichedPrompt = buildPrompt(
      `[Voice message transcribed]: ${effectiveTranscription}`,
      voiceDocket,
      relevantContext,
      elasticContext,
      "telegram",
      agentResult?.dispatch.agent ? { system_prompt: agentResult.dispatch.agent.system_prompt, name: agentResult.dispatch.agent.name, tools_enabled: agentResult.dispatch.agent.tools_enabled } : undefined,
      undefined, voiceStructured, recentMessages,
      agentResult?.dispatch.skill_context,
      forestContext,
      voiceAgentMem || undefined,
      agentMemory.sessionIds,
      await getAgentArchetype(agentResult?.dispatch.agent?.name),
      await getPsyContext(),
      await getPhaseContext(),
      await getHealthContext(),
      voiceQueueContext || undefined,
      liveForest.incidents || undefined,
      voiceForestAwareness || undefined,
      (await getSkillSnapshot(getCreatureProfile(agentResult?.dispatch.agent?.name)?.allowed_skills)).prompt || undefined,
      voiceContextMode,
      voiceRefreshed,
    );

    // ── ELLIE-383: Context snapshot logging for voice ──
    const voiceBuildMetrics = getLastBuildMetrics();
    if (voiceBuildMetrics) {
      const top5 = [...voiceBuildMetrics.sections].sort((a, b) => b.tokens - a.tokens).slice(0, 5);
      console.log(
        `[context:snapshot] creature=${voiceBuildMetrics.creature || "general"} mode=${voiceBuildMetrics.mode || "default"} ` +
        `tokens=${voiceBuildMetrics.totalTokens} sections=${voiceBuildMetrics.sectionCount} budget=${voiceBuildMetrics.budget} ` +
        `top5=[${top5.map(s => `${s.label}:${s.tokens}`).join(", ")}]`
      );
      broadcastExtension({
        type: "context_snapshot",
        channel: "telegram",
        creature: voiceBuildMetrics.creature || "general",
        contextMode: voiceBuildMetrics.mode || "conversation",
        totalTokens: voiceBuildMetrics.totalTokens,
        sectionCount: voiceBuildMetrics.sectionCount,
        budget: voiceBuildMetrics.budget,
        top5: top5.map(s => ({ label: s.label, tokens: s.tokens })),
      });
    }

    const agentTools = agentResult?.dispatch.agent.tools_enabled;
    const agentModel = agentResult?.dispatch.agent.model;

    const startTime = Date.now();
    const rawResponse = await callClaudeWithTyping(ctx, enrichedPrompt, {
      resume: true,
      allowedTools: agentTools?.length ? agentTools : undefined,
      model: agentModel || undefined,
    });
    const durationMs = Date.now() - startTime;
    const claudeResponse = await processMemoryIntents(supabase, rawResponse, agentResult?.dispatch.agent.name || "general", "shared", agentMemory.sessionIds);

    // Try voice response for short replies without approval buttons
    const TTS_MAX_CHARS = 1500;
    const { cleanedText, confirmations } = extractApprovalTags(claudeResponse);

    if (confirmations.length === 0 && cleanedText.length <= TTS_MAX_CHARS && ELEVENLABS_API_KEY) {
      const audioBuffer = await textToSpeechOgg(cleanedText);
      if (audioBuffer) {
        await ctx.replyWithVoice(new InputFile(audioBuffer, "response.ogg"));
        await sendResponse(ctx, cleanedText);
        await saveMessage("assistant", cleanedText, undefined, "telegram", voiceUserId);
        runPostMessageAssessment(transcription, cleanedText, anthropic).catch(err => logger.error("Post-message assessment failed", err));

        if (agentResult) {
          syncResponse(supabase, agentResult.dispatch.session_id, cleanedText, {
            duration_ms: durationMs,
          }).catch(() => {});
        }

        resetTelegramIdleTimer();
        return;
      }
    }

    // Fall back to text (long response, TTS failure, or approval buttons)
    const cleanedResponse = await sendWithApprovals(ctx, claudeResponse, session.sessionId, agentResult?.dispatch.agent.name);

    await saveMessage("assistant", cleanedResponse, undefined, "telegram", voiceUserId);
    runPostMessageAssessment(transcription, cleanedResponse, anthropic).catch(err => logger.error("Post-message assessment failed", err));

    if (agentResult) {
      syncResponse(supabase, agentResult.dispatch.session_id, cleanedResponse, {
        duration_ms: durationMs,
      }).catch(() => {});
    }

    resetTelegramIdleTimer();
  } catch (error) {
    logger.error("Voice processing failed", error);
    await ctx.reply("Could not process voice message. Check logs for details.");
  }
}, (ctx) => `[Voice ${ctx.message?.voice?.duration ?? 0}s]`));

// Photos/Images
bot.on("message:photo", withQueue(async (ctx) => {
  console.log("Image received");
  await ctx.replyWithChatAction("typing");

  try {
    // Get highest resolution photo
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    // Download the image
    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    // Claude Code can see images via file path
    const caption = ctx.message.caption || "Analyze this image.";
    const prompt = `[Image: ${filePath}]\n\n${caption}`;

    const imgUserId = ctx.from?.id.toString() || "";
    await saveMessage("user", `[Image]: ${caption}`, undefined, "telegram", imgUserId);

    const claudeResponse = await callClaudeWithTyping(ctx, prompt, { resume: true });

    // Cleanup after processing
    await unlink(filePath).catch(() => {});

    // Use the last-routed agent for context (photo/doc handlers don't route independently)
    const activeAgent = getActiveAgent("telegram");
    const cleanResponse = await processMemoryIntents(supabase, claudeResponse, activeAgent);
    const finalResponse = await sendWithApprovals(ctx, cleanResponse, session.sessionId, activeAgent);
    await saveMessage("assistant", finalResponse, undefined, "telegram", imgUserId);
    resetTelegramIdleTimer();
  } catch (error) {
    logger.error("Image processing failed", error);
    await ctx.reply("Could not process image.");
  }
}, (ctx) => ctx.message?.caption?.substring(0, 50) ?? "[Photo]"));

// Documents
bot.on("message:document", withQueue(async (ctx) => {
  const doc = ctx.message.document;
  console.log(`Document: ${doc.file_name}`);
  await ctx.replyWithChatAction("typing");

  try {
    const file = await ctx.getFile();
    const timestamp = Date.now();
    const fileName = doc.file_name || `file_${timestamp}`;
    const filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
    const prompt = `[File: ${filePath}]\n\n${caption}`;

    const docUserId = ctx.from?.id.toString() || "";
    await saveMessage("user", `[Document: ${doc.file_name}]: ${caption}`, undefined, "telegram", docUserId);

    const claudeResponse = await callClaudeWithTyping(ctx, prompt, { resume: true });

    await unlink(filePath).catch(() => {});

    const activeAgent = getActiveAgent("telegram");
    const cleanResponse = await processMemoryIntents(supabase, claudeResponse, activeAgent);
    const finalResponse = await sendWithApprovals(ctx, cleanResponse, session.sessionId, activeAgent);
    await saveMessage("assistant", finalResponse, undefined, "telegram", docUserId);
    resetTelegramIdleTimer();
  } catch (error) {
    logger.error("Document processing failed", error);
    await ctx.reply("Could not process document.");
  }
}, (ctx) => ctx.message?.document?.file_name ?? "[Document]"));

// ============================================================
// APPROVAL CALLBACKS
// ============================================================

bot.callbackQuery(/^approve:(.+)$/, withQueue(async (ctx) => {
  const actionId = ctx.match![1];
  const action = getPendingAction(actionId);

  if (!action) {
    await ctx.answerCallbackQuery({ text: "This action has expired." });
    return;
  }

  await ctx.editMessageText(`\u2705 Approved: ${action.description}`);
  await ctx.answerCallbackQuery({ text: "Approved" });
  removePendingAction(actionId);

  const approveUserId = ctx.from?.id.toString() || "";
  await saveMessage("user", `[Approved action: ${action.description}]`, undefined, "telegram", approveUserId);

  const resumePrompt = `The user APPROVED the following action: "${action.description}". Proceed with executing it now.`;

  await ctx.replyWithChatAction("typing");
  const rawResponse = await callClaudeWithTyping(ctx, resumePrompt, { resume: true });
  const approveAgent = action.agentName || getActiveAgent("telegram");
  const response = await processMemoryIntents(supabase, rawResponse, approveAgent);
  const cleanedResponse = await sendWithApprovals(ctx, response, session.sessionId, approveAgent);
  await saveMessage("assistant", cleanedResponse, undefined, "telegram", approveUserId);
  resetTelegramIdleTimer();
}, () => "[Approval]"));

bot.callbackQuery(/^deny:(.+)$/, withQueue(async (ctx) => {
  const actionId = ctx.match![1];
  const action = getPendingAction(actionId);

  if (!action) {
    await ctx.answerCallbackQuery({ text: "This action has expired." });
    return;
  }

  await ctx.editMessageText(`\u274c Denied: ${action.description}`);
  await ctx.answerCallbackQuery({ text: "Denied" });
  removePendingAction(actionId);

  const denyUserId = ctx.from?.id.toString() || "";
  await saveMessage("user", `[Denied action: ${action.description}]`, undefined, "telegram", denyUserId);

  const resumePrompt = `The user DENIED the following action: "${action.description}". Do NOT proceed with this action. Acknowledge briefly.`;

  await ctx.replyWithChatAction("typing");
  const rawResponse = await callClaudeWithTyping(ctx, resumePrompt, { resume: true });
  const denyAgent = action.agentName || getActiveAgent("telegram");
  const response = await processMemoryIntents(supabase, rawResponse, denyAgent);
  const cleanedResponse = await sendWithApprovals(ctx, response, session.sessionId, denyAgent);
  await saveMessage("assistant", cleanedResponse, undefined, "telegram", denyUserId);
  resetTelegramIdleTimer();
}, () => "[Denial]"));
}
