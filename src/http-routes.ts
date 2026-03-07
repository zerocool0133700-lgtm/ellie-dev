/**
 * HTTP route handlers — all Express-style routes for the relay HTTP server.
 *
 * Extracted from relay.ts — ELLIE-184 Phase 1.
 * This is the largest extraction (~2,440 lines of route handlers).
 */

import { spawn } from "bun";
import { writeFile, appendFile, mkdir, readFile, unlink } from "fs/promises";
import { join } from "path";
import type { IncomingMessage, ServerResponse } from "http";
import { WebSocket } from "ws";
import Anthropic from "@anthropic-ai/sdk";
import {
  PROJECT_ROOT, BOT_TOKEN, ALLOWED_USER_ID, CLAUDE_PATH, PROJECT_DIR, RELAY_DIR,
  AGENT_MODE, ALLOWED_TOOLS, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID,
  HTTP_PORT, PUBLIC_URL, EXTENSION_API_KEY, ALLOWED_CALLERS, GCHAT_SPACE_NOTIFY,
  validateTwilioSignature, TEMP_DIR, UPLOADS_DIR,
  getContextDocket, clearContextCache,
} from "./relay-config.ts";
import {
  getActiveAgent, setActiveAgent,
  extensionClients, ellieChatClients, wsAppUserMap,
  broadcastExtension, broadcastToEllieChatClients,
  getRelayDeps, getNotifyCtx,
} from "./relay-state.ts";
import { triggerConsolidation, resetTelegramIdleTimer, resetGchatIdleTimer } from "./relay-idle.ts";
import {
  textToSpeechOgg,
  textToSpeechFast,
  textToSpeechFastStream,
  textToSpeechOggStream,
  getTTSProviderInfo,
} from "./tts.ts";
import { signToken, authenticateRequest } from "./api/jwt-auth.ts";
import {
  buildPrompt,
  getArchetypeContext,
  getAgentArchetype,
  getAgentRoleContext,
  getPsyContext,
  getPhaseContext,
  getHealthContext,
  runPostMessageAssessment,
  getPlanningMode,
  setPlanningMode,
  getLastBuildMetrics,
  USER_NAME,
  USER_TIMEZONE,
} from "./prompt-builder.ts";
import { transcribe } from "./transcribe.ts";
import {
  callClaude,
  session,
} from "./claude-cli.ts";
import {
  getQueueStatus,
  listDeadLetters,
  clearAllDeadLetters,
  clearDeadLetterById,
} from "./message-queue.ts";
import { getChannelHealth } from "./channel-health.ts";
import { getTaskStatus } from "./periodic-task.ts";
import { getFireForgetMetrics } from "./resilient-task.ts";
import { checkContextPressure, shouldNotify, getCompactionNotice, checkpointSessionToForest } from "./api/session-compaction.ts";
import { primeWorkingMemoryCache } from "./working-memory.ts";
import { getReconcileStatus } from "./elasticsearch/reconcile.ts";
import { handleTicketStatus } from "./api/ticket-status-handler.ts";
import {
  saveMessage,
  sendWithApprovals,
  sendWithApprovalsEllieChat,
  ellieChatPendingActions,
} from "./message-sender.ts";
import {
  processMemoryIntents,
  getRelevantContext,
} from "./memory.ts";
import { searchElastic } from "./elasticsearch.ts";
import { getForestContext } from "./elasticsearch/context.ts";
import {
  parseGoogleChatEvent,
  sendGoogleChatMessage,
  isAllowedSender,
  isGoogleChatEnabled,
  type GoogleChatEvent,
} from "./google-chat.ts";
import {
  deliverMessage,
  acknowledgeChannel,
} from "./delivery.ts";
import { checkMessageRate, checkHttpRateLimit, getRateLimitStatus } from "./rate-limiter.ts";
import { getBreakerStatus } from "./resilience.ts";
import { getPlaneQueueStatus } from "./plane-queue.ts";
import {
  routeAndDispatch,
  syncResponse,
  type RouteResult,
} from "./agent-router.ts";
import { getSkillSnapshot, matchInstantCommand } from "./skills/index.ts";
import { getCreatureProfile } from "./creature-profile.ts";
import {
  formatForestMetrics,
  estimateTokens,
} from "./relay-utils.ts";
import {
  getAgentStructuredContext, getAgentMemoryContext, getMaxMemoriesForModel,
  getGoogleTasksJSON, getLiveForestContext,
} from "./context-sources.ts";
import { syncAllCalendars } from "./calendar-sync.ts";
import {
  isOutlookConfigured,
  getOutlookEmail,
  listUnread as outlookListUnread,
  searchMessages as outlookSearchMessages,
  getMessage as outlookGetMessage,
  sendEmail as outlookSendEmail,
  replyToMessage as outlookReplyToMessage,
  markAsRead as outlookMarkAsRead,
} from "./outlook.ts";
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
  listOpenIssues,
  createPlaneIssue,
} from "./plane.ts";
import { extractPlaybookCommands, executePlaybookCommands, type PlaybookContext } from "./playbook.ts";
import { notify } from "./notification-policy.ts";
import {
  getOrCreateConversation,
  closeActiveConversation,
  closeConversation,
  getConversationContext,
  getConversationMessages,
  getConversationById,
} from "./conversations.ts";
import {
  getQueueContext,
  acknowledgeQueueItems,
  getQueueStats,
  getAndAcknowledgeReadouts,
} from "./api/agent-queue.ts";
import {
  handleToolApprovalHTTP,
  resolveToolApproval,
  clearSessionApprovals,
} from "./tool-approval.ts";
import { handleGatewayRoute } from "./api/gateway-intake.ts";
import { handleGtdRoute } from "./api/gtd.ts";
import { getSummaryState } from "./ums/consumers/summary.ts";
import { log } from "./logger.ts";
import { resilientTask } from "./resilient-task.ts";
import { detectAndCaptureCorrection } from "./correction-detector.ts";
import { detectAndLinkCalendarEvents } from "./calendar-linker.ts";
import { freshnessTracker, autoRefreshStaleSources, detectConflicts } from "./context-freshness.ts";
import { checkGroundTruthConflicts, buildCrossChannelSection } from "./source-hierarchy.ts";
import { getModeConfig, updateModeConfig, resetModeConfig, detectMode, isContextRefresh, type ContextMode } from "./context-mode.ts";
import { getSectionContents, updateSectionContent } from "./api/context-sections.ts";
import type { ApiRequest, ApiResponse } from "./api/types.ts";
import { getActiveRunStates, getRunState, killRun } from "./orchestration-tracker.ts";
import { getRecentEvents, getRunEvents } from "./orchestration-ledger.ts";
import { executeTrackedDispatch } from "./orchestration-dispatch.ts";
import { withTrace } from "./trace.ts";
import { getQueueStatus } from "./dispatch-queue.ts";
// ELLIE-550: per-domain route handlers extracted from handleHttpRequest()
import { handleAnalyticsRoute } from "./api/routes/analytics.ts";
import { handleMemoryRoute } from "./api/routes/memory.ts";
import { handleCommsRoute } from "./api/routes/comms.ts";
import { handleCalendarIntelRoute } from "./api/routes/calendar-intel.ts";
import { handleRelationshipsRoute } from "./api/routes/relationships.ts";
import { handleBriefingRoute } from "./api/routes/briefing.ts";
import { handleAlertsRoute } from "./api/routes/alerts.ts";
// ELLIE-547: CORS whitelist (replaces wildcard *)
import { handlePreflight, corsHeader } from "./cors.ts";

const logger = log.child("http");

/**
 * ELLIE-546: Returns true when a request to `pathname` from `clientIp` requires API authentication.
 * Pure function — easy to unit test.
 *
 * Exemptions:
 *   - /api/auth/token     — issues tokens, must be reachable unauthenticated
 *   - /api/bridge/*       — uses its own x-bridge-key scheme
 *   - /api/app-auth/*     — handles its own auth flow
 *   - Localhost IPs       — on-machine agents bypass auth
 */
export function requiresApiAuth(pathname: string, clientIp: string): boolean {
  if (!pathname.startsWith("/api/")) return false;
  if (pathname === "/api/auth/token") return false;
  if (pathname.startsWith("/api/bridge/")) return false;
  if (pathname.startsWith("/api/app-auth/")) return false;
  const isLocalhost = clientIp === "127.0.0.1" || clientIp === "::1" || clientIp === "::ffff:127.0.0.1";
  if (isLocalhost) return false;
  return true;
}

export async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { bot, anthropic, supabase } = getRelayDeps();

  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // ELLIE-554: IP-based rate limiting for all HTTP requests (skips localhost)
  if (checkHttpRateLimit(req, res)) return;

  // ELLIE-547: CORS preflight — must run before auth/routing
  if (handlePreflight(req, res)) return;

  // Gateway intake endpoints (ELLIE-151) — forwarded from ellie-gateway
  if (req.method === "POST" && handleGatewayRoute(req, res, url.pathname)) return;

  // GTD API endpoints (ELLIE-275) — agent-facing GTD interaction
  if (handleGtdRoute(req, res, url.pathname, supabase)) return;

  // Twilio TwiML webhook — tells Twilio to open a media stream
  if (url.pathname === "/voice" && req.method === "POST") {
    // Validate Twilio signature
    let voiceBody = "";
    req.on("data", (chunk: Buffer) => { voiceBody += chunk.toString(); });
    req.on("end", () => {
      if (!validateTwilioSignature(req, voiceBody)) {
        logger.warn("Invalid Twilio signature — rejecting request");
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      // Caller whitelist — only allow known numbers
      if (ALLOWED_CALLERS.size > 0) {
        const params = new URLSearchParams(voiceBody);
        const caller = (params.get("From") || "").replace(/\D/g, "");
        if (!ALLOWED_CALLERS.has(caller)) {
          logger.warn("Rejected call — not in whitelist", { from: params.get("From") });
          const rejectTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>Sorry, this number is not authorized.</Say><Hangup/></Response>`;
          res.writeHead(200, { "Content-Type": "application/xml" });
          res.end(rejectTwiml);
          return;
        }
        logger.info("Accepted call", { from: params.get("From") });
      }

    const wsUrl = PUBLIC_URL
      ? PUBLIC_URL.replace(/^https?/, "wss") + "/media-stream"
      : `wss://${req.headers.host}/media-stream`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting you to Ellie.</Say>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end(twiml);
    logger.info("TwiML served, connecting media stream...");
    }); // end req.on("end")
    return;
  }

  // Google Chat webhook
  if (url.pathname === "/google-chat" && req.method === "POST") {
    // Read body
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        // ELLIE-553: Bearer token verification
        const { verifyGoogleChatRequest } = await import("./channels/google-chat/verify.ts");
        const gchatVerifyResult = verifyGoogleChatRequest(
          req.headers["authorization"] as string | undefined,
          process.env.GOOGLE_CHAT_VERIFICATION_TOKEN,
        );
        if (gchatVerifyResult === "unauthorized") {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
        if (gchatVerifyResult === "unconfigured") {
          logger.warn("Google Chat verification not configured — set GOOGLE_CHAT_VERIFICATION_TOKEN");
        }

        const event: GoogleChatEvent = JSON.parse(body);

        // Handle card button clicks (approval actions)
        const eventRecord = event as Record<string, unknown>;
        const cardAction = (eventRecord as { chat?: { cardClickedPayload?: unknown } })?.chat?.cardClickedPayload ||
          (eventRecord?.type === "CARD_CLICKED" ? event : null);
        if (cardAction) {
          const cardRecord = cardAction as Record<string, unknown>;
          const actionFn = (cardRecord as { chat?: { cardClickedPayload?: { action?: { actionMethodName?: string } } } })?.chat?.cardClickedPayload?.action?.actionMethodName ||
            (cardRecord as { action?: { actionMethodName?: string } })?.action?.actionMethodName || "";
          const params = (cardRecord as { chat?: { cardClickedPayload?: { action?: { parameters?: Array<{ key: string; value: string }> } } } })?.chat?.cardClickedPayload?.action?.parameters ||
            (cardRecord as { action?: { parameters?: Array<{ key: string; value: string }> } })?.action?.parameters || [];
          const actionId = params.find((p: { key: string; value: string }) => p.key === "action_id")?.value;

          if (actionId && (actionFn === "approve_action" || actionFn === "deny_action")) {
            const pending = getPendingAction(actionId);
            if (pending) {
              const approved = actionFn === "approve_action";
              removePendingAction(actionId);
              logger.info(`Action ${approved ? "approved" : "denied"}: ${pending.description.substring(0, 60)}`);

              // Immediately acknowledge the button click with card update
              const ackText = `${approved ? "\u2705 Approved" : "\u274C Denied"}: ${pending.description}`;
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                actionResponse: { type: "UPDATE_MESSAGE" },
                cardsV2: [{
                  cardId: "approval_card",
                  card: {
                    header: { title: approved ? "Action Approved" : "Action Denied" },
                    sections: [{
                      widgets: [{ textParagraph: { text: ackText } }],
                    }],
                  },
                }],
              }));

              // Resume Claude with the decision asynchronously (don't block webhook)
              const decision = approved
                ? `The user APPROVED the action: "${pending.description}". Proceed with the action now.`
                : `The user DENIED the action: "${pending.description}". Do NOT proceed. Acknowledge and move on.`;

              // Use stored session ID from when the approval was created
              callClaude(decision, {
                resume: true,
                sessionId: pending.sessionId || undefined,
              }).then(async (followUp) => {
                const cleanFollowUp = await processMemoryIntents(supabase, followUp, pending.agentName || getActiveAgent("google-chat"));
                await saveMessage("assistant", cleanFollowUp, {}, "google-chat");

                // Send follow-up via REST API to the correct space
                if (pending.spaceName) {
                  await sendGoogleChatMessage(pending.spaceName, cleanFollowUp).catch((err) => {
                    logger.error("Failed to send approval follow-up", err);
                  });
                }
                logger.info(`Approval follow-up sent: ${cleanFollowUp.substring(0, 80)}...`);
              }).catch((err) => {
                logger.error("Approval Claude call failed", err);
                // Try to notify the user about the error
                if (pending.spaceName) {
                  sendGoogleChatMessage(pending.spaceName, "Sorry, I ran into an error processing that approval. Please try again.").catch(() => {});
                }
              });
              return;
            }

            // Expired action — update the card to show expiry
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              actionResponse: { type: "UPDATE_MESSAGE" },
              cardsV2: [{
                cardId: "approval_card",
                card: {
                  header: { title: "Action Expired" },
                  sections: [{
                    widgets: [{ textParagraph: { text: "This action has expired. Please try again." } }],
                  }],
                },
              }],
            }));
            return;
          }
        }

        const parsed = parseGoogleChatEvent(event);

        if (!parsed) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
          return;
        }

        if (!isAllowedSender(parsed.senderEmail)) {
          logger.info("Unauthorized sender", { email: parsed.senderEmail });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
          return;
        }

        logger.info("Incoming message", { sender: parsed.senderName, preview: parsed.text.substring(0, 80) });

        // Rate limit check (ELLIE-228)
        const gchatRateLimited = checkMessageRate(parsed.senderEmail, "google-chat");
        if (gchatRateLimited) {
          const gchatRateResponse = { text: gchatRateLimited };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(gchatRateResponse));
          return;
        }

        acknowledgeChannel("google-chat"); // User responded — clear pending responses

        await saveMessage("user", parsed.text, {
          sender: parsed.senderEmail,
          space: parsed.spaceName,
        }, "google-chat", parsed.senderEmail);
        broadcastExtension({ type: "message_in", channel: "google-chat", preview: parsed.text.substring(0, 200) });

        // Correction detection + calendar linking (ELLIE-250)
        if (supabase) {
          const gchatConvIdForHooks = await getOrCreateConversation(supabase, "google-chat");
          if (gchatConvIdForHooks) {
            // Correction detection — check if user is correcting last assistant response
            supabase.from("messages")
              .select("content")
              .eq("conversation_id", gchatConvIdForHooks)
              .eq("role", "assistant")
              .order("created_at", { ascending: false })
              .limit(1)
              .single()
              .then(({ data }) => {
                if (data?.content) {
                  resilientTask("detectAndCaptureCorrection", "best-effort", () =>
                    detectAndCaptureCorrection(parsed.text, data.content, anthropic, "google-chat", gchatConvIdForHooks));
                }
              })
              .catch(() => {});

            // Calendar-conversation linking — detect event mentions
            resilientTask("detectAndLinkCalendarEvents", "best-effort", () =>
              detectAndLinkCalendarEvents(parsed.text, supabase, gchatConvIdForHooks));
          }
        }

        // /plan on|off — planning mode toggle
        const gchatPlanMatch = parsed.text.match(/^\/plan\s+(on|off)$/i);
        if (gchatPlanMatch) {
          setPlanningMode(gchatPlanMatch[1].toLowerCase() === "on");
          const msg = getPlanningMode()
            ? "Planning mode ON — conversation will persist for up to 60 minutes of idle time."
            : "Planning mode OFF — reverting to 10-minute idle timeout.";
          resetTelegramIdleTimer();
          resetGchatIdleTimer();
          resetEllieChatIdleTimer();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text: msg } } } },
          }));
          return;
        }

        // Slash commands — direct responses, bypass Claude pipeline (ELLIE-113)
        if (parsed.text.startsWith("/search ")) {
          const query = parsed.text.slice(8).trim();
          let responseText = "Usage: /search <query>";
          if (query) {
            try {
              const { searchForestSafe } = await import("./elasticsearch/search-forest.ts");
              responseText = (await searchForestSafe(query, { limit: 10 })) || "No results found.";
            } catch (err) {
              logger.error("gchat /search error", err);
              responseText = "Search failed — ES may be unavailable.";
            }
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text: responseText } } } },
          }));
          return;
        }

        if (parsed.text === "/forest-metrics" || parsed.text.startsWith("/forest-metrics ")) {
          let responseText: string;
          try {
            const { getForestMetricsSafe } = await import("./elasticsearch/search-forest.ts");
            const now = new Date();
            const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            const metrics = await getForestMetricsSafe({
              timeRange: { from: weekAgo.toISOString(), to: now.toISOString() },
            });
            responseText = formatForestMetrics(metrics);
          } catch (err) {
            logger.error("gchat /forest-metrics error", err);
            responseText = "Metrics failed — ES may be unavailable.";
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text: responseText } } } },
          }));
          return;
        }

        // Instant skill commands — static content, no Claude call (sub-100ms)
        try {
          const instant = await matchInstantCommand(parsed.text);
          if (instant) {
            logger.info(`Instant command: /${instant.skillName} ${instant.subcommand}`);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text: instant.response } } } },
            }));
            return;
          }
        } catch (err) {
          logger.warn("Instant command match failed", err);
        }

        // Immediately acknowledge — all routing + Claude work happens async.
        // This prevents Google Chat's ~30s webhook timeout from showing "not responding".
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text: "Working on it..." } } } },
        }));

        // All remaining work is async — response delivered via Chat API
        // ELLIE-398: Wrap async processing in trace context
        withTrace(() => (async () => {
          try {
            // ELLIE-391: Context refresh — bust all caches so this message gets fully fresh data
            if (isContextRefresh(parsed.text)) {
              freshnessTracker.clear();
              clearContextCache();
              logger.info("refresh triggered — reloading all sources");
            }

            const gchatWorkItem = parsed.text.match(/\b([A-Z]+-\d+)\b/)?.[1];
            const gchatPreRoute = detectMode(parsed.text);
            const gchatSkillOverride = gchatPreRoute?.mode === "skill-only" ? "road-runner" : undefined;
            const gchatAgentResult = await routeAndDispatch(supabase, parsed.text, "google-chat", parsed.senderEmail, gchatWorkItem, gchatSkillOverride);
            const effectiveGchatText = gchatAgentResult?.route.strippedMessage || parsed.text;
            if (gchatAgentResult) {
              setActiveAgent("google-chat", gchatAgentResult.dispatch.agent.name);
              broadcastExtension({ type: "route", channel: "google-chat", agent: gchatAgentResult.dispatch.agent.name, mode: gchatAgentResult.route.execution_mode, confidence: gchatAgentResult.route.confidence, contextMode: gchatPreRoute?.mode || undefined });

              // Dispatch confirmation — routed through notification policy (ELLIE-80)
              if (gchatAgentResult.dispatch.agent.name !== "general" && gchatAgentResult.dispatch.is_new) {
                const agentName = gchatAgentResult.dispatch.agent.name;
                notify(getNotifyCtx(), {
                  event: "dispatch_confirm",
                  workItemId: agentName,
                  telegramMessage: `🤖 ${agentName} agent`,
                  gchatMessage: `🤖 ${agentName} agent dispatched`,
                }).catch((err) => logger.error("dispatch_confirm failed", err));
              }
            }

            const gchatActiveAgent = getActiveAgent("google-chat");
            const gchatConvoId = await getOrCreateConversation(supabase!, "google-chat") || undefined;

            // ── ELLIE-325: Message-level mode detection ──
            const { processMessageMode } = await import("./context-mode.ts");
            const gchatConvoKey = gchatConvoId || "gchat-default";
            const { mode: gchatContextMode, changed: gchatModeChanged } = processMessageMode(gchatConvoKey, effectiveGchatText);
            if (gchatModeChanged) {
              logger.info(`Context mode changed`, { mode: gchatContextMode, channel: "gchat" });
            }

            const [gchatConvoContext, contextDocket, relevantContext, elasticContext, structuredContext, forestContext, agentMemory, gchatQueueContext, liveForest] = await Promise.all([
              gchatConvoId && supabase ? getConversationMessages(supabase, gchatConvoId) : Promise.resolve({ text: "", messageCount: 0, conversationId: "" }),
              getContextDocket(),
              getRelevantContext(supabase, effectiveGchatText, "google-chat", gchatActiveAgent, gchatConvoId),
              searchElastic(effectiveGchatText, { limit: 5, recencyBoost: true, channel: "google-chat", sourceAgent: gchatActiveAgent, excludeConversationId: gchatConvoId }),
              getAgentStructuredContext(supabase, gchatActiveAgent),
              getForestContext(effectiveGchatText),
              getAgentMemoryContext(gchatActiveAgent, gchatWorkItem, getMaxMemoriesForModel(gchatAgentResult?.dispatch.agent.model)),
              gchatAgentResult?.dispatch.is_new ? getQueueContext(gchatActiveAgent) : Promise.resolve(""),
              getLiveForestContext(effectiveGchatText),
            ]);
            const recentMessages = gchatConvoContext.text;
            if (gchatAgentResult?.dispatch.is_new && gchatQueueContext) {
              resilientTask("acknowledgeQueueItems", "critical", () => acknowledgeQueueItems(gchatActiveAgent));
            }

            // ELLIE-327: Track section-level freshness for non-registry sources
            if (recentMessages) freshnessTracker.recordFetch("recent-messages", 0);
            if (gchatQueueContext) freshnessTracker.recordFetch("queue", 0);
            if (contextDocket) freshnessTracker.recordFetch("context-docket", 0);
            if (relevantContext || elasticContext || forestContext) freshnessTracker.recordFetch("search", 0);

            // ELLIE-327: Log mode config + freshness status
            freshnessTracker.logModeConfig(gchatContextMode);
            freshnessTracker.logAllFreshness(gchatContextMode);

            // ELLIE-327: Auto-refresh stale critical sources
            const { refreshed: gchatRefreshed, results: gchatRefreshResults } = await autoRefreshStaleSources(
              gchatContextMode,
              {
                "structured-context": () => getAgentStructuredContext(supabase, gchatActiveAgent),
                "context-docket": () => { clearContextCache(); return getContextDocket(); },
                "agent-memory": async () => {
                  const mem = await getAgentMemoryContext(gchatActiveAgent, gchatWorkItem, getMaxMemoriesForModel(gchatAgentResult?.dispatch.agent.model));
                  return mem.memoryContext;
                },
                "forest-awareness": async () => {
                  const lf = await getLiveForestContext(effectiveGchatText);
                  return lf.awareness;
                },
              },
            );

            // ELLIE-327: Apply auto-refresh results
            const gchatStructured = gchatRefreshResults["structured-context"] || structuredContext;
            const gchatDocket = gchatRefreshResults["context-docket"] || contextDocket;
            const gchatForestAwareness = gchatRefreshResults["forest-awareness"] || liveForest.awareness;
            const gchatAgentMem = gchatRefreshResults["agent-memory"] || agentMemory.memoryContext;

            // Detect work item mentions (ELLIE-5, EVE-3, etc.) — matches Telegram text handler
            let workItemContext = "";
            const workItemMatch = effectiveGchatText.match(/\b([A-Z]+-\d+)\b/);
            const isGchatWorkIntent = gchatAgentResult?.route.skill_name === "code_changes" ||
              gchatAgentResult?.route.skill_name === "code_review" ||
              gchatAgentResult?.route.skill_name === "debugging";
            if (workItemMatch && isPlaneConfigured()) {
              const details = await fetchWorkItemDetails(workItemMatch[1]);
              if (details) {
                const label = isGchatWorkIntent ? "ACTIVE WORK ITEM" : "REFERENCED WORK ITEM";
                workItemContext = `\n${label}: ${workItemMatch[1]}\n` +
                  `Title: ${details.name}\n` +
                  `Priority: ${details.priority}\n` +
                  `Description: ${details.description}\n`;
                freshnessTracker.recordFetch("work-item", 0);
              }
            }

            // ── Google Chat multi-step branch (ELLIE-58) ──
            if (gchatAgentResult?.route.execution_mode !== "single" && gchatAgentResult?.route.skills?.length) {
              const gchatExecMode = gchatAgentResult.route.execution_mode;
              const gchatSteps: PipelineStep[] = gchatAgentResult.route.skills.map((s) => ({
                agent_name: s.agent,
                skill_name: s.skill !== "none" ? s.skill : undefined,
                instruction: s.instruction,
              }));

              const GCHAT_ORCHESTRATION_TIMEOUT_MS = 300_000; // 5 minutes max
              const result = await Promise.race([
                executeOrchestrated(gchatExecMode, gchatSteps, effectiveGchatText, {
                  supabase,
                  channel: "google-chat",
                  userId: parsed.senderEmail,
                  anthropicClient: anthropic,
                  contextDocket: gchatDocket, relevantContext, elasticContext,
                  structuredContext: gchatStructured, recentMessages, workItemContext, forestContext,
                  buildPromptFn: buildPrompt,
                  callClaudeFn: callClaude,
                }),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error("Orchestration timeout (5m)")), GCHAT_ORCHESTRATION_TIMEOUT_MS),
                ),
              ]);

              const gchatOrcAgent = result.finalDispatch?.agent?.name || gchatAgentResult?.dispatch.agent.name || "general";
              const pipelineResponse = await processMemoryIntents(supabase, result.finalResponse, gchatOrcAgent, "shared", agentMemory.sessionIds);
              const { cleanedText: gchatOrcPlaybookClean, commands: gchatOrcPlaybookCmds } = extractPlaybookCommands(pipelineResponse);
              const { cleanedText: gchatClean } = extractApprovalTags(gchatOrcPlaybookClean);
              await saveMessage("assistant", gchatClean, { space: parsed.spaceName }, "google-chat", parsed.senderEmail);
              broadcastExtension({ type: "message_out", channel: "google-chat", agent: gchatOrcAgent, preview: gchatClean.substring(0, 200) });
              broadcastExtension({ type: "pipeline_complete", channel: "google-chat", mode: gchatExecMode, steps: result.stepResults.length, duration_ms: result.artifacts.total_duration_ms, cost_usd: result.artifacts.total_cost_usd });
              resetGchatIdleTimer();

              if (result.finalDispatch) {
                resilientTask("syncResponse", "critical", () => syncResponse(supabase, result.finalDispatch!.session_id, gchatClean, {
                  duration_ms: result.artifacts.total_duration_ms,
                }));
              }

              logger.info(`${gchatExecMode}: ${result.stepResults.length} steps in ${result.artifacts.total_duration_ms}ms, $${result.artifacts.total_cost_usd.toFixed(4)}`);

              await deliverMessage(supabase, gchatClean, {
                channel: "google-chat",
                spaceName: parsed.spaceName,
                threadName: null,
                telegramBot: bot,
                telegramChatId: ALLOWED_USER_ID,
                fallback: true,
              });

              // Fire playbook commands async (ELLIE:: tags)
              if (gchatOrcPlaybookCmds.length > 0) {
                const pbCtx: PlaybookContext = { bot, supabase, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, channel: "google-chat", callClaudeFn: callClaude, buildPromptFn: buildPrompt };
                resilientTask("executePlaybookCommands", "best-effort", () => executePlaybookCommands(gchatOrcPlaybookCmds, pbCtx));
              }

              // Psy assessment (ELLIE-333: was missing for Google Chat)
              resilientTask("runPostMessageAssessment", "best-effort", () => runPostMessageAssessment(effectiveGchatText, gchatClean, anthropic));
              return;
            }

            // ── Google Chat single-agent path (default) ──
            // ELLIE-250 Phase 3: Proactive conflict detection + cross-channel sync
            const gchatContextSections = [
              { label: "structured-context", content: gchatStructured || "" },
              { label: "context-docket", content: gchatDocket || "" },
              { label: "work-item", content: workItemContext || "" },
              { label: "forest-awareness", content: gchatForestAwareness || "" },
            ];
            const [gchatGroundTruthConflicts, gchatCrossChannel] = await Promise.all([
              checkGroundTruthConflicts(effectiveGchatText, gchatContextSections),
              buildCrossChannelSection(supabase, "google-chat"),
            ]);

            // ELLIE-541: Populate working memory cache so buildPrompt can inject session context
            const _gchatAgentName = gchatAgentResult?.dispatch.agent?.name || "general";
            try { await primeWorkingMemoryCache(session.sessionId, _gchatAgentName); } catch { /* non-critical */ }

            const enrichedPrompt = buildPrompt(
              effectiveGchatText, gchatDocket, relevantContext, elasticContext, "google-chat",
              gchatAgentResult?.dispatch.agent ? { system_prompt: gchatAgentResult.dispatch.agent.system_prompt, name: gchatAgentResult.dispatch.agent.name, tools_enabled: gchatAgentResult.dispatch.agent.tools_enabled } : undefined,
              workItemContext || undefined, gchatStructured, recentMessages,
              gchatAgentResult?.dispatch.skill_context,
              forestContext,
              gchatAgentMem || undefined,
              agentMemory.sessionIds,
              await getAgentArchetype(gchatAgentResult?.dispatch.agent?.name),
              await getAgentRoleContext(gchatAgentResult?.dispatch.agent?.name),
              await getPsyContext(),
              await getPhaseContext(),
              await getHealthContext(),
              gchatQueueContext || undefined,
              liveForest.incidents || undefined,
              gchatForestAwareness || undefined,
              (await getSkillSnapshot(getCreatureProfile(gchatAgentResult?.dispatch.agent?.name)?.allowed_skills)).prompt || undefined,
              gchatContextMode,
              gchatRefreshed,
              undefined, // channelProfile (Google Chat doesn't use channels)
              gchatGroundTruthConflicts || undefined,
              gchatCrossChannel || undefined,
            );

            // ELLIE-383: Context snapshot logging (journal only)
            const gchatBuildMetrics = getLastBuildMetrics();
            if (gchatBuildMetrics) {
              const top5 = [...gchatBuildMetrics.sections].sort((a, b) => b.tokens - a.tokens).slice(0, 5);
              logger.info("Context snapshot", {
                creature: gchatBuildMetrics.creature || "general",
                mode: gchatBuildMetrics.mode || "default",
                tokens: gchatBuildMetrics.totalTokens,
                sections: gchatBuildMetrics.sectionCount,
                budget: gchatBuildMetrics.budget,
                top5: top5.map(s => `${s.label}:${s.tokens}`).join(", "),
              });
            }

            const gchatAgentTools = gchatAgentResult?.dispatch.agent.tools_enabled;
            const gchatAgentModel = gchatAgentResult?.dispatch.agent.model;

            const gchatStart = Date.now();
            let rawResponse = await callClaude(enrichedPrompt, {
              resume: true,
              allowedTools: gchatAgentTools?.length ? gchatAgentTools : undefined,
              model: gchatAgentModel || undefined,
            });
            const gchatDuration = Date.now() - gchatStart;

            // ELLIE-528: Context pressure monitoring — Google Chat path
            const gchatContextPressure = gchatBuildMetrics ? checkContextPressure(gchatBuildMetrics) : null;
            if (gchatContextPressure && gchatConvoId && shouldNotify(gchatConvoId, gchatContextPressure.level)) {
              rawResponse += getCompactionNotice(gchatContextPressure);
              if (gchatContextPressure.level === "critical" && gchatBuildMetrics) {
                resilientTask("checkpointSessionToForest", "best-effort", () => checkpointSessionToForest({
                  conversationId: gchatConvoId,
                  agentName: gchatAgentResult?.dispatch.agent.name || "general",
                  mode: gchatBuildMetrics.mode ?? gchatContextMode,
                  workItemId: gchatWorkItem,
                  pressure: gchatContextPressure,
                  sections: gchatBuildMetrics.sections,
                  lastUserMessage: effectiveGchatText,
                }));
              }
            }

            const response = await processMemoryIntents(supabase, rawResponse, gchatAgentResult?.dispatch.agent.name || "general", "shared", agentMemory.sessionIds);
            const { cleanedText: gchatPlaybookClean, commands: gchatPlaybookCmds } = extractPlaybookCommands(response);

            if (gchatAgentResult) {
              resilientTask("syncResponse", "critical", () => syncResponse(supabase, gchatAgentResult!.dispatch.session_id, gchatPlaybookClean, {
                duration_ms: gchatDuration,
              }));
            }

            const { cleanedText: gchatClean } = extractApprovalTags(gchatPlaybookClean);
            const msgId = await saveMessage("assistant", gchatClean, { space: parsed.spaceName }, "google-chat", parsed.senderEmail);
            broadcastExtension({ type: "message_out", channel: "google-chat", agent: gchatAgentResult?.dispatch.agent.name || "general", preview: gchatClean.substring(0, 200) });
            resetGchatIdleTimer();
            logger.info(`Async reply (${gchatClean.length} chars)`, { spaceName: parsed.spaceName, preview: gchatClean.substring(0, 80) });

            const gchatDeliverResult = await deliverMessage(supabase, gchatClean, {
              channel: "google-chat",
              messageId: msgId || undefined,
              spaceName: parsed.spaceName,
              threadName: null,
              telegramBot: bot,
              telegramChatId: ALLOWED_USER_ID,
              fallback: true,
            });

            if (gchatDeliverResult.status === "sent") {
              logger.info(`Async delivery complete`, { externalId: gchatDeliverResult.externalId });
            } else if (gchatDeliverResult.status === "fallback") {
              logger.info(`Async delivery via fallback`, { channel: gchatDeliverResult.channel, externalId: gchatDeliverResult.externalId });
            } else {
              logger.error("Async delivery failed", { error: gchatDeliverResult.error });
            }

            // Fire playbook commands async (ELLIE:: tags)
            if (gchatPlaybookCmds.length > 0) {
              const pbCtx: PlaybookContext = { bot, supabase, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, channel: "google-chat", callClaudeFn: callClaude, buildPromptFn: buildPrompt };
              resilientTask("executePlaybookCommands", "best-effort", () => executePlaybookCommands(gchatPlaybookCmds, pbCtx));
            }

            // Psy assessment (ELLIE-333: was missing for Google Chat)
            resilientTask("runPostMessageAssessment", "best-effort", () => runPostMessageAssessment(effectiveGchatText, gchatClean, anthropic));
          } catch (err) {
            logger.error("Async processing error", err);
            const errMsg = err instanceof PipelineStepError && err.partialOutput
              ? err.partialOutput + "\n\n(Execution incomplete.)"
              : "Sorry, I ran into an error while processing your request. Please try again.";
            deliverMessage(supabase, errMsg, {
              channel: "google-chat",
              spaceName: parsed.spaceName,
              threadName: null,
              telegramBot: bot,
              telegramChatId: ALLOWED_USER_ID,
              fallback: true,
              maxRetries: 1,
            }).catch(() => {});
          }
        })());

      } catch (err) {
        logger.error("Webhook error", err);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          hostAppDataAction: {
            chatDataAction: {
              createMessageAction: {
                message: { text: "Sorry, I ran into an error. Please try again." },
              },
            },
          },
        }));
      }
    });
    return;
  }

  // ── Slack Events API + Slash Commands (ELLIE-443) ────────────────────────────
  if (url.pathname === "/slack" && req.method === "POST") {
    let rawBody = "";
    req.on("data", (chunk: Buffer) => { rawBody += chunk.toString(); });
    req.on("end", async () => {
      const signingSecret = process.env.SLACK_SIGNING_SECRET;
      const botToken = process.env.SLACK_BOT_TOKEN;
      if (!signingSecret || !botToken) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Slack not configured" }));
        return;
      }

      // Signature verification
      const { verifySlackRequest } = await import("./channels/slack/verify.ts");
      const timestamp = req.headers["x-slack-request-timestamp"] as string ?? "";
      const signature = req.headers["x-slack-signature"] as string ?? "";
      if (!verifySlackRequest(signingSecret, rawBody, timestamp, signature)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid signature" }));
        return;
      }

      const contentType = req.headers["content-type"] ?? "";

      // ── Slash commands (application/x-www-form-urlencoded) ───
      if (contentType.includes("application/x-www-form-urlencoded")) {
        const { handleSlackCommand } = await import("./channels/slack/handler.ts");
        const params = new URLSearchParams(rawBody);
        const payload = {
          command: params.get("command") ?? "",
          text: params.get("text") ?? "",
          user_id: params.get("user_id") ?? "",
          channel_id: params.get("channel_id") ?? "",
          response_url: params.get("response_url") ?? "",
          trigger_id: params.get("trigger_id") ?? "",
        };
        const ackText = await handleSlackCommand(payload);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ response_type: "ephemeral", text: ackText }));
        return;
      }

      // ── Events API (application/json) ─────────────────────────
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      // URL verification challenge (one-time during app setup)
      if (payload.type === "url_verification") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ challenge: payload.challenge }));
        return;
      }

      // Acknowledge immediately — Slack requires response within 3s
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));

      // Process event asynchronously
      if (payload.type === "event_callback") {
        const event = payload.event as Record<string, unknown> | undefined;
        if (!event) return;

        const eventType = event.type as string;
        // Handle: app_mention and DMs (message.im)
        if (eventType === "app_mention" || (eventType === "message" && event.channel_type === "im")) {
          const { handleSlackEvent } = await import("./channels/slack/handler.ts");
          const { resolveAgent } = await import("./channels/slack/index.ts");
          handleSlackEvent(event as Parameters<typeof handleSlackEvent>[0], resolveAgent)
            .catch(err => logger.error("Slack event handler error", { error: err instanceof Error ? err.message : String(err) }));
        }
      }

      return;
    });
    return;
  }

  // Alexa Custom Skill webhook
  if (url.pathname === "/alexa" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        // ELLIE-553: Alexa signature headers are always present in production.
        // Reject requests that are missing them — do not silently allow.
        const certUrl = req.headers["signaturecertchainurl"] as string | undefined;
        const signature = req.headers["signature-256"] as string | undefined;

        const { verifyAlexaRequest, hasAlexaSignatureHeaders } = await import("./alexa.ts");
        if (!hasAlexaSignatureHeaders(certUrl, signature)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing Alexa signature headers" }));
          return;
        }
        const valid = await verifyAlexaRequest(certUrl!, signature!, body);
        if (!valid) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid signature" }));
          return;
        }

        const {
          parseAlexaRequest, handleAddTodo, handleGetTodos, handleGetBriefing,
          buildAlexaResponse, buildAlexaErrorResponse, textToSsml,
        } = await import("./alexa.ts");

        const alexaBody = JSON.parse(body);
        const parsed = parseAlexaRequest(alexaBody);

        logger.info(`${parsed.type} ${parsed.intentName || ""}`, { preview: parsed.text.substring(0, 80) });

        // Save user message
        await saveMessage("user", parsed.text, {
          userId: parsed.userId,
          sessionId: parsed.sessionId,
          intent: parsed.intentName,
        }, "alexa", parsed.userId);
        broadcastExtension({ type: "message_in", channel: "alexa", preview: parsed.text.substring(0, 200) });

        // Handle request types
        if (parsed.type === "LaunchRequest") {
          const resp = buildAlexaResponse(
            "Hi! I'm Ellie. You can ask me anything, say add a todo, or ask for your briefing. What would you like?",
            false, // Keep session open
            "Ellie",
            "Ask me anything, add a todo, or get your briefing.",
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(resp));
          return;
        }

        if (parsed.type === "SessionEndedRequest") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ version: "1.0", response: {} }));
          return;
        }

        // IntentRequest
        const intent = parsed.intentName;
        let speechText: string;
        let shouldEndSession = true;

        switch (intent) {
          case "AddTodoIntent": {
            speechText = await handleAddTodo(parsed.slots);
            break;
          }
          case "GetTodosIntent": {
            speechText = await handleGetTodos();
            break;
          }
          case "GetBriefingIntent": {
            speechText = await handleGetBriefing();
            break;
          }
          case "AskEllieIntent": {
            const query = parsed.slots.query || parsed.text;

            // Route first, then gather context with correct agent
            const alexaWorkItem = query.match(/\b([A-Z]+-\d+)\b/)?.[1];
            const alexaPreRoute = detectMode(query);
            const alexaSkillOverride = alexaPreRoute?.mode === "skill-only" ? "road-runner" : undefined;
            const agentResult = await routeAndDispatch(supabase, query, "alexa", parsed.userId, alexaWorkItem, alexaSkillOverride);
            if (agentResult) {
              setActiveAgent("alexa", agentResult.dispatch.agent.name);
              broadcastExtension({ type: "route", channel: "alexa", agent: agentResult.dispatch.agent.name, mode: agentResult.route.execution_mode, confidence: agentResult.route.confidence, contextMode: alexaPreRoute?.mode || undefined });
            }
            const effectiveQuery = agentResult?.route.strippedMessage || query;

            // Gather context with correct active agent
            const alexaActiveAgent = getActiveAgent("alexa");
            const alexaConvoId = await getOrCreateConversation(supabase!, "alexa") || undefined;
            const [alexaConvoContext, contextDocket, relevantContext, elasticContext, structuredContext, forestContext, agentMemory, alexaQueueContext, liveForest] = await Promise.all([
              alexaConvoId && supabase ? getConversationMessages(supabase, alexaConvoId) : Promise.resolve({ text: "", messageCount: 0, conversationId: "" }),
              getContextDocket(),
              getRelevantContext(supabase, effectiveQuery, "alexa", alexaActiveAgent, alexaConvoId),
              searchElastic(effectiveQuery, { limit: 5, recencyBoost: true, channel: "alexa", sourceAgent: alexaActiveAgent, excludeConversationId: alexaConvoId }),
              getAgentStructuredContext(supabase, alexaActiveAgent),
              getForestContext(effectiveQuery),
              getAgentMemoryContext(alexaActiveAgent, alexaWorkItem, getMaxMemoriesForModel(agentResult?.dispatch.agent.model)),
              agentResult?.dispatch.is_new ? getQueueContext(alexaActiveAgent) : Promise.resolve(""),
              getLiveForestContext(effectiveQuery),
            ]);
            const recentMessages = alexaConvoContext.text;
            if (agentResult?.dispatch.is_new && alexaQueueContext) {
              resilientTask("acknowledgeQueueItems", "critical", () => acknowledgeQueueItems(alexaActiveAgent));
            }
            // ELLIE-541: Populate working memory cache so buildPrompt can inject session context
            const _alexaAgentName = agentResult?.dispatch.agent?.name || "general";
            try { await primeWorkingMemoryCache(session.sessionId, _alexaAgentName); } catch { /* non-critical */ }

            const enrichedPrompt = buildPrompt(
              effectiveQuery, contextDocket, relevantContext, elasticContext, "alexa",
              agentResult?.dispatch.agent ? {
                system_prompt: agentResult.dispatch.agent.system_prompt,
                name: agentResult.dispatch.agent.name,
                tools_enabled: agentResult.dispatch.agent.tools_enabled,
              } : undefined,
              undefined, structuredContext, recentMessages,
              agentResult?.dispatch.skill_context,
              forestContext,
              agentMemory.memoryContext || undefined,
              agentMemory.sessionIds,
              await getAgentArchetype(agentResult?.dispatch.agent?.name),
              await getAgentRoleContext(agentResult?.dispatch.agent?.name),
              await getPsyContext(),
              await getPhaseContext(),
              await getHealthContext(),
              alexaQueueContext || undefined,
              liveForest.incidents || undefined,
              liveForest.awareness || undefined,
              (await getSkillSnapshot(getCreatureProfile(agentResult?.dispatch.agent?.name)?.allowed_skills)).prompt || undefined,
              undefined, // contextMode
              undefined, // refreshedSources
              undefined, // channelProfile
            );

            // ELLIE-383: Context snapshot logging (journal only)
            const alexaBuildMetrics = getLastBuildMetrics();
            if (alexaBuildMetrics) {
              const top5 = [...alexaBuildMetrics.sections].sort((a, b) => b.tokens - a.tokens).slice(0, 5);
              logger.info("Context snapshot", {
                creature: alexaBuildMetrics.creature || "general",
                mode: alexaBuildMetrics.mode || "default",
                tokens: alexaBuildMetrics.totalTokens,
                sections: alexaBuildMetrics.sectionCount,
                budget: alexaBuildMetrics.budget,
                top5: top5.map(s => `${s.label}:${s.tokens}`).join(", "),
              });
            }

            const ALEXA_TIMEOUT_MS = 6_000;
            const claudePromise = (async () => {
              const raw = await callClaude(enrichedPrompt, {
                resume: true,
                allowedTools: agentResult?.dispatch.agent.tools_enabled?.length
                  ? agentResult.dispatch.agent.tools_enabled : undefined,
                model: agentResult?.dispatch.agent.model || undefined,
              });
              return await processMemoryIntents(supabase, raw, agentResult?.dispatch.agent.name || "general", "shared", agentMemory.sessionIds);
            })();

            const timeoutPromise = new Promise<"timeout">((resolve) =>
              setTimeout(() => resolve("timeout"), ALEXA_TIMEOUT_MS)
            );

            const raceResult = await Promise.race([
              claudePromise.then((r) => ({ type: "done" as const, response: r })),
              timeoutPromise.then(() => ({ type: "timeout" as const })),
            ]);

            if (raceResult.type === "timeout") {
              // Claude still working — tell user, deliver via Telegram
              speechText = "I'm still thinking about that. I'll send the full answer to your Telegram.";
              claudePromise
                .then(async (response) => {
                  const clean = response.replace(/<[^>]+>/g, "").substring(0, 4000);
                  await saveMessage("assistant", clean, { source: "alexa-async" }, "alexa", parsed.userId);
                  broadcastExtension({ type: "message_out", channel: "alexa", agent: agentResult?.dispatch.agent.name || "general", preview: clean.substring(0, 200) });
                  try {
                    await bot.api.sendMessage(ALLOWED_USER_ID, `[From Alexa] ${clean}`);
                  } catch (tgErr) {
                    logger.error("Telegram fallback failed", tgErr);
                  }
                })
                .catch((err) => logger.error("Async Claude error", err));
            } else {
              const clean = raceResult.response.replace(/<[^>]+>/g, "").substring(0, 6000);
              await saveMessage("assistant", clean, {}, "alexa", parsed.userId);
              broadcastExtension({ type: "message_out", channel: "alexa", agent: agentResult?.dispatch.agent.name || "general", preview: clean.substring(0, 200) });
              speechText = clean;
            }
            break;
          }
          case "AMAZON.HelpIntent": {
            speechText = "You can ask me anything, say add a todo followed by your task, say what's on my todo list, or ask for your briefing. What would you like?";
            shouldEndSession = false;
            break;
          }
          case "AMAZON.StopIntent":
          case "AMAZON.CancelIntent": {
            speechText = "Goodbye!";
            break;
          }
          default: {
            speechText = "I'm not sure how to help with that. Try asking me a question, or say help for options.";
            shouldEndSession = false;
          }
        }

        const resp = buildAlexaResponse(speechText, shouldEndSession, "Ellie");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(resp));
      } catch (err) {
        logger.error("Webhook error", err);
        const { buildAlexaErrorResponse } = await import("./alexa.ts");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(buildAlexaErrorResponse()));
      }
    });
    return;
  }

  // Health check — comprehensive service status (ELLIE-225)
  if (url.pathname === "/health") {
    const circuitBreakers = getBreakerStatus();
    const anyBreakerOpen = Object.values(circuitBreakers).some(b => b.state === "open");
    const status = anyBreakerOpen ? "degraded" : "ok";

    getPlaneQueueStatus().then(planeQueue => {
      res.writeHead(status === "ok" ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status,
        service: "ellie-relay",
        uptime: Math.round(process.uptime()),
        memory: {
          rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
          heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        },
        channels: {
          telegram: true,
          googleChat: isGoogleChatEnabled(),
          voice: !!ELEVENLABS_API_KEY,
          alexa: true,
        },
        queue: getQueueStatus(),
        planeQueue,
        circuitBreakers,
        rateLimits: getRateLimitStatus(),
        // ELLIE-460: Live dependency health (Supabase, Telegram, Forest)
        dependencies: getChannelHealth(),
        // ELLIE-492: Periodic task status
        periodicTasks: getTaskStatus(),
        // ELLIE-479: Fire-and-forget resilience metrics
        fireAndForget: getFireForgetMetrics(),
        // ELLIE-496: ES reconciliation status
        esReconciliation: getReconcileStatus(),
      }));
    }).catch(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status, service: "ellie-relay", uptime: Math.round(process.uptime()) }));
    });
    return;
  }

  // Queue status — returns current processing state and queued items
  if (url.pathname === "/queue-status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getQueueStatus()));
    return;
  }

  // ELLIE-546: API auth middleware — see requiresApiAuth() for exemption rules.
  if (requiresApiAuth(url.pathname, req.socket?.remoteAddress ?? "")) {
    const auth = await authenticateRequest(req, "api", EXTENSION_API_KEY);
    if (!auth) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
  }

  // Dead-letter queue — inspect and clear (ELLIE-490)
  if (url.pathname === "/api/dead-letters") {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ deadLetters: listDeadLetters() }));
      return;
    }
    if (req.method === "DELETE") {
      await clearAllDeadLetters();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ cleared: true }));
      return;
    }
  }

  if (url.pathname.startsWith("/api/dead-letters/") && req.method === "DELETE") {
    const id = url.pathname.slice("/api/dead-letters/".length);
    if (id) {
      const found = await clearDeadLetterById(id);
      res.writeHead(found ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ cleared: found }));
      return;
    }
  }

  // Context Freshness Dashboard — source freshness snapshot (ELLIE-329)
  if (url.pathname === "/api/freshness" && req.method === "GET") {
    const modeParam = url.searchParams.get("mode") || "conversation";
    const validModes = ["conversation", "strategy", "workflow", "deep-work"];
    const mode = validModes.includes(modeParam) ? modeParam as ContextMode : "conversation";

    const snapshot = freshnessTracker.getSnapshot(mode);
    const conflicts = detectConflicts();

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ...snapshot,
      conflicts,
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  // ── Context Mode Config — GET /api/context-modes ──────────
  if (url.pathname === "/api/context-modes" && req.method === "GET") {
    const config = getModeConfig();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(config));
    return;
  }

  // ── ELLIE-375: Test mode detection — POST /api/context-modes/detect ──
  if (url.pathname === "/api/context-modes/detect" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        const { message } = JSON.parse(body);
        if (!message) { res.writeHead(400); res.end('{"error":"message required"}'); return; }
        const detection = detectMode(message);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detection, input: message }));
      } catch { res.writeHead(400); res.end('{"error":"invalid json"}'); }
    });
    return;
  }

  // ── Context Mode Config — PUT /api/context-modes ──────────
  if (url.pathname === "/api/context-modes" && req.method === "PUT") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        if (data.reset) {
          resetModeConfig();
        } else {
          updateModeConfig(data.priorities, data.budgets);
        }
        const config = getModeConfig();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(config));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "Invalid request body" }));
      }
    });
    return;
  }

  // ── Context Sections — GET /api/context-sections ──────────
  if (url.pathname === "/api/context-sections" && req.method === "GET") {
    (async () => {
      try {
        const sections = await getSectionContents();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sections }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "Failed to load sections" }));
      }
    })();
    return;
  }

  // ── Context Sections — PUT /api/context-sections/:name ────
  if (url.pathname.startsWith("/api/context-sections/") && req.method === "PUT") {
    const sectionName = url.pathname.split("/api/context-sections/")[1];
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const { content } = JSON.parse(body);
        if (typeof content !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "content must be a string" }));
          return;
        }
        const result = await updateSectionContent(sectionName, content);
        if (!result.ok) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: result.error }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "Invalid request body" }));
      }
    });
    return;
  }

  // ── Orchestration Status — GET /api/orchestration/status ────
  if (url.pathname === "/api/orchestration/status" && req.method === "GET") {
    (async () => {
      try {
        const activeRuns = getActiveRunStates();
        const recentEvents = await getRecentEvents(50);
        const queue = getQueueStatus(); // ELLIE-396: Include queue status
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ activeRuns, recentEvents, queue }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "Failed to get orchestration status" }));
      }
    })();
    return;
  }

  // ── Orchestration Run Detail — GET /api/orchestration/status/:runId ──
  if (url.pathname.startsWith("/api/orchestration/status/") && req.method === "GET") {
    const runId = url.pathname.split("/api/orchestration/status/")[1];
    if (!runId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing runId" }));
      return;
    }
    (async () => {
      try {
        const run = getRunState(runId);
        const events = await getRunEvents(runId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ run, events }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "Failed to get run detail" }));
      }
    })();
    return;
  }

  // ── Orchestration Dispatch — POST /api/orchestration/dispatch ──
  if (url.pathname === "/api/orchestration/dispatch" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const { agent_type, work_item_id, message } = data;
        if (!agent_type || !work_item_id) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "agent_type and work_item_id are required" }));
          return;
        }

        // Build a minimal playbook context from relay deps
        const { bot: relayBot, supabase: relaySb } = getRelayDeps();
        if (!relayBot) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Relay not fully initialized" }));
          return;
        }

        // ELLIE-398: Wrap dispatch in trace context
        const { runId } = withTrace(() => executeTrackedDispatch({
          agentType: agent_type,
          workItemId: work_item_id,
          channel: "api",
          message: message || `Work on ${work_item_id}`,
          playbookCtx: {
            bot: relayBot,
            supabase: relaySb,
            telegramUserId: ALLOWED_USER_ID,
            channel: "api",
            callClaudeFn: (p, o) => callClaude(p, { ...o, runId }),
            buildPromptFn: buildPrompt,
          },
        }));

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ run_id: runId, status: "dispatched" }));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "Invalid request body" }));
      }
    });
    return;
  }

  // ── Orchestration Cancel — POST /api/orchestration/:runId/cancel ──
  const cancelMatch = url.pathname.match(/^\/api\/orchestration\/([0-9a-f-]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    const runId = cancelMatch[1];
    (async () => {
      try {
        const killed = await killRun(runId);
        if (!killed) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Run not found or already ended" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, run_id: runId, status: "cancelled" }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "Cancel failed" }));
      }
    })();
    return;
  }

  // ── Orchestration Retry — POST /api/orchestration/:runId/retry ──
  const retryMatch = url.pathname.match(/^\/api\/orchestration\/([0-9a-f-]+)\/retry$/);
  if (retryMatch && req.method === "POST") {
    const runId = retryMatch[1];
    (async () => {
      try {
        // Look up the original dispatched event to get params
        const events = await getRunEvents(runId);
        const dispatchedEvt = events.find(e => e.event_type === "dispatched");
        if (!dispatchedEvt) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Original dispatch event not found" }));
          return;
        }

        // Emit retried event on old run
        const { emitEvent } = await import("./orchestration-ledger.ts");
        emitEvent(runId, "retried", dispatchedEvt.agent_type, dispatchedEvt.work_item_id, { original_run_id: runId });

        // Start a new tracked dispatch with same params
        const { bot: relayBot, supabase: relaySb } = getRelayDeps();
        if (!relayBot) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Relay not fully initialized" }));
          return;
        }

        const agentType = dispatchedEvt.agent_type || "dev";
        const workItemId = dispatchedEvt.work_item_id || "";

        const { runId: newRunId } = executeTrackedDispatch({
          agentType,
          workItemId,
          channel: "api",
          message: `Retry of ${runId.slice(0, 8)}`,
          playbookCtx: {
            bot: relayBot,
            supabase: relaySb,
            telegramUserId: ALLOWED_USER_ID,
            channel: "api",
            callClaudeFn: (p, o) => callClaude(p, { ...o, runId: newRunId }),
            buildPromptFn: buildPrompt,
          },
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, original_run_id: runId, new_run_id: newRunId, status: "retried" }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "Retry failed" }));
      }
    })();
    return;
  }

  // ── Jobs — ELLIE-438/439 ──────────────────────────────────────────────────

  // POST /api/jobs — create job
  if (url.pathname === "/api/jobs" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const { createJob, appendJobEvent } = await import("./jobs-ledger.ts");
        const data = JSON.parse(body || "{}");
        const jobId = await createJob({
          type: data.type || "dispatch",
          source: data.source,
          parent_job_id: data.parent_job_id,
          work_item_id: data.work_item_id,
          agent_type: data.agent_type,
          model: data.model,
          prompt_summary: data.prompt_summary,
          tools_enabled: data.tools_enabled,
          input_data: data.input_data,
          run_id: data.run_id,
        });
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ job_id: jobId }));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "Failed to create job" }));
      }
    });
    return;
  }

  // GET /api/jobs/metrics — aggregated stats (must be before /:id)
  if (url.pathname === "/api/jobs/metrics" && req.method === "GET") {
    (async () => {
      try {
        const { getJobMetrics } = await import("./jobs-ledger.ts");
        const since = url.searchParams.get("since") ?? undefined;
        const metrics = await getJobMetrics(since);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(metrics));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "Failed to get metrics" }));
      }
    })();
    return;
  }

  // GET /api/jobs — list jobs with filters
  if (url.pathname === "/api/jobs" && req.method === "GET") {
    (async () => {
      try {
        const { listJobs } = await import("./jobs-ledger.ts");
        const jobs = await listJobs({
          status: (url.searchParams.get("status") as any) || undefined,
          type: (url.searchParams.get("type") as any) || undefined,
          agent_type: url.searchParams.get("agent") || undefined,
          work_item_id: url.searchParams.get("work_item_id") || undefined,
          since: url.searchParams.get("since") || undefined,
          limit: parseInt(url.searchParams.get("limit") || "50", 10),
          offset: parseInt(url.searchParams.get("offset") || "0", 10),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jobs }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "Failed to list jobs" }));
      }
    })();
    return;
  }

  // GET /api/jobs/:id — full job detail
  const jobDetailMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})$/);
  if (jobDetailMatch && req.method === "GET") {
    const jobId = jobDetailMatch[1];
    (async () => {
      try {
        const { getJob } = await import("./jobs-ledger.ts");
        const detail = await getJob(jobId);
        if (!detail) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Job not found" }));
          return;
        }
        // ELLIE-449: Include creature chain (pull creature + push child) if job has a creature_id
        let creatures: unknown[] = [];
        if (detail.job.creature_id) {
          const { getCreature, getChildCreatures } = await import("../../ellie-forest/src/index");
          const [root, children] = await Promise.all([
            getCreature(detail.job.creature_id),
            getChildCreatures(detail.job.creature_id),
          ]);
          creatures = [root, ...children].filter(Boolean);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...detail, creatures }));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "Failed to get job" }));
      }
    })();
    return;
  }

  // PATCH /api/jobs/:id — update job progress/status
  const jobPatchMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})$/);
  if (jobPatchMatch && req.method === "PATCH") {
    const jobId = jobPatchMatch[1];
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const { updateJob, appendJobEvent } = await import("./jobs-ledger.ts");
        const data = JSON.parse(body || "{}");
        await updateJob(jobId, {
          status: data.status,
          current_step: data.current_step,
          completed_steps: data.completed_steps,
          last_heartbeat: data.heartbeat ? new Date() : undefined,
          total_duration_ms: data.total_duration_ms,
          tokens_in: data.tokens_in,
          tokens_out: data.tokens_out,
          cost_usd: data.cost_usd,
          result: data.result,
        });
        if (data.event) {
          await appendJobEvent(jobId, data.event, data.event_details, { step_name: data.current_step });
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "Failed to update job" }));
      }
    });
    return;
  }

  // Ground Truth Index — ELLIE-250
  if (url.pathname === "/api/ground-truth" && req.method === "GET") {
    (async () => {
      try {
        const { listGroundTruth } = await import("./data-quality.ts");
        const limit = parseInt(url.searchParams.get("limit") || "20", 10);
        const offset = parseInt(url.searchParams.get("offset") || "0", 10);
        const corrections = await listGroundTruth(supabase, { limit, offset });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(corrections));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "Failed to fetch ground truth" }));
      }
    })();
    return;
  }

  // Accuracy Stats — ELLIE-250
  if (url.pathname === "/api/accuracy" && req.method === "GET") {
    (async () => {
      try {
        const { getAccuracyStats } = await import("./data-quality.ts");
        const stats = await getAccuracyStats(supabase);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(stats));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "Failed to fetch accuracy stats" }));
      }
    })();
    return;
  }

  // Summary Bar — module status for Ellie Chat (ELLIE-315)
  if (url.pathname === "/api/summary" && req.method === "GET") {
    (async () => {
      try {
        const summary = await getSummaryState(supabase);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(summary));
      } catch (err) {
        logger.error("Summary endpoint error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to build summary" }));
      }
    })();
    return;
  }

  // JWT token endpoint — exchange API key for a short-lived JWT (ELLIE-233)
  if (url.pathname === "/api/auth/token" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const apiKey = req.headers["x-api-key"] as string;
        if (!apiKey || apiKey !== EXTENSION_API_KEY || !EXTENSION_API_KEY) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid API key" }));
          return;
        }
        const data = body ? JSON.parse(body) : {};
        const subject = data.subject || "dashboard";
        const scopes = Array.isArray(data.scopes) ? data.scopes : ["tts", "stt"];
        const token = await signToken(subject, scopes);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ token }));
      } catch (err: unknown) {
        logger.error("Token issue error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Token generation failed" }));
      }
    });
    return;
  }

  // TTS provider info — returns available providers
  if (url.pathname === "/api/tts/provider" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getTTSProviderInfo()));
    return;
  }

  // TTS endpoint — returns OGG audio for dashboard playback
  if (url.pathname === "/api/tts" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        // ELLIE-233: JWT auth (preferred) or legacy x-api-key (backwards compat)
        const auth = await authenticateRequest(req, "tts", EXTENSION_API_KEY);
        if (!auth) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
        const data = JSON.parse(body);
        if (!data.text || typeof data.text !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing 'text' field" }));
          return;
        }
        const fast = data.fast === true || url.searchParams.get("fast") === "1";
        const providerOverride = (data.provider === "elevenlabs" || data.provider === "openai") ? data.provider : undefined;

        // ELLIE-258: Stream audio directly from provider to client
        const stream = fast
          ? await textToSpeechFastStream(data.text, providerOverride)
          : await textToSpeechOggStream(data.text, providerOverride);
        if (!stream) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "TTS unavailable" }));
          return;
        }
        res.writeHead(200, { "Content-Type": stream.contentType });
        for await (const chunk of stream.body) {
          res.write(chunk);
        }
        res.end();
      } catch (err: unknown) {
        logger.error("TTS API error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  // STT endpoint — accepts audio, returns transcription
  if (url.pathname === "/api/stt" && req.method === "POST") {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    req.on("end", async () => {
      try {
        // ELLIE-233: JWT auth (preferred) or legacy x-api-key (backwards compat)
        const auth = await authenticateRequest(req, "stt", EXTENSION_API_KEY);
        if (!auth) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
        const audioBuffer = Buffer.concat(chunks);
        if (audioBuffer.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No audio data" }));
          return;
        }
        const text = await transcribe(audioBuffer);
        if (!text) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ text: "", error: "Could not transcribe" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text }));
      } catch (err: unknown) {
        logger.error("STT API error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  // Token health check — tests Anthropic API key validity
  if (url.pathname === "/api/token-health") {
    (async () => {
      const result: Record<string, { status: string; latency_ms?: number; error?: string }> = {};

      // Anthropic
      if (!anthropic) {
        result.anthropic = { status: "not_configured" };
      } else {
        const start = Date.now();
        try {
          await anthropic.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1,
            messages: [{ role: "user", content: "ok" }],
          });
          result.anthropic = { status: "ok", latency_ms: Date.now() - start };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          let status = "error";
          if (msg.includes("credit balance")) status = "low_credits";
          else if ((err as { status?: number })?.status === 401) status = "invalid_key";
          result.anthropic = { status, latency_ms: Date.now() - start, error: msg };
        }
      }

      // ELLIE-408: Include fallback status
      const { isFallbackActive: getFallbackActive } = await import("./llm-provider.ts");
      (result as Record<string, unknown>).fallback_active = getFallbackActive();
      (result as Record<string, unknown>).openai = {
        status: process.env.OPENAI_API_KEY ? "configured" : "not_configured",
      };
      // ELLIE-459: Include channel health (cached — no live checks here)
      (result as Record<string, unknown>).channels = getChannelHealth();
      // ELLIE-621: Include identity system status
      const { getIdentityStatus } = await import("./identity-startup.ts");
      (result as Record<string, unknown>).identity = getIdentityStatus();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    })();
    return;
  }

  // Google Tasks — return pending tasks as JSON (ELLIE-277: moved from /api/gtd)
  if (url.pathname === "/api/google-tasks" && req.method === "GET") {
    (async () => {
      try {
        const data = await getGoogleTasksJSON();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Failed to fetch tasks" }));
      }
    })();
    return;
  }

  // Calendar sync — manual trigger
  if (url.pathname === "/api/calendar-sync" && req.method === "POST") {
    (async () => {
      try {
        await syncAllCalendars();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Sync failed" }));
      }
    })();
    return;
  }

  // Calendar events — read from ellie-forest DB
  if (url.pathname === "/api/calendar" && req.method === "GET") {
    (async () => {
      try {
        const { sql: forestSql } = await import("../../ellie-forest/src/index.ts");
        const now = new Date().toISOString();
        const weekOut = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        const data = await forestSql`
          SELECT * FROM calendar_events
          WHERE end_time >= ${now} AND start_time <= ${weekOut} AND status != 'cancelled'
          ORDER BY start_time ASC
        `;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data || []));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([]));
      }
    })();
    return;
  }

  // Manual consolidation (close conversation)
  if (url.pathname === "/api/consolidate" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const channel = data.channel || undefined;
        logger.info(`Manual consolidation trigger via API`, { channel });
        await triggerConsolidation(channel);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        logger.error("Consolidate API error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    });
    return;
  }

  // Create Plane ticket from context (messages, memories, or freeform text)
  if (url.pathname === "/api/ticket/from-context" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const contextParts: string[] = [];

        if (data.messages?.length) {
          contextParts.push("CONVERSATION:\n" + data.messages.join("\n---\n"));
        }

        if (data.memory_ids?.length && supabase) {
          const { data: mems } = await supabase.from("memory")
            .select("type, content")
            .in("id", data.memory_ids);
          if (mems?.length) {
            contextParts.push("MEMORIES:\n" + mems.map((m: { type: string; content: string }) => `[${m.type}] ${m.content}`).join("\n"));
          }
        }

        if (data.text) {
          contextParts.push("CONTEXT:\n" + data.text);
        }

        if (contextParts.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No context provided. Include messages, memory_ids, or text." }));
          return;
        }

        const context = contextParts.join("\n\n");
        const prompt = `Generate a Plane project ticket from this context. Return ONLY valid JSON with no markdown formatting:\n{"title": "concise title under 80 chars", "description": "detailed description with requirements as bullet points", "priority": "medium"}\n\nPriority must be one of: urgent, high, medium, low, none.\n\nContext:\n${context}`;

        logger.info(`Generating ticket from ${contextParts.length} context source(s)...`);
        const raw = await callClaude(prompt);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("Could not parse ticket JSON from Claude response");
        const ticket = JSON.parse(jsonMatch[0]);

        if (!ticket.title) throw new Error("Generated ticket has no title");

        const result = await createPlaneIssue("ELLIE", ticket.title, ticket.description, ticket.priority);
        if (!result) throw new Error("Plane API failed to create issue");

        logger.info(`Created ${result.identifier}: ${ticket.title}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, identifier: result.identifier, title: ticket.title, description: ticket.description }));
      } catch (err: unknown) {
        logger.error("Ticket creation error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Failed to create ticket" }));
      }
    });
    return;
  }

  // ELLIE-570: Ticket status — QMD-first with Plane reconciliation
  if (url.pathname === "/api/ticket/status" && req.method === "GET") {
    (async () => {
      const result = await handleTicketStatus(url.searchParams.get("id"));
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.body));
    })();
    return;
  }

  // Execution plans — list or get details (ELLIE-58)
  if (url.pathname === "/api/execution-plans" && req.method === "GET") {
    (async () => {
      if (!supabase) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Supabase not configured" }));
        return;
      }
      const rawLimit = parseInt(url.searchParams.get("limit") || "20", 10);
      const rawOffset = parseInt(url.searchParams.get("offset") || "0", 10);
      if (isNaN(rawLimit) || isNaN(rawOffset)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid pagination parameters" }));
        return;
      }
      const limit = Math.min(Math.max(rawLimit, 1), 100);
      const offset = Math.max(rawOffset, 0);
      const status = url.searchParams.get("status");

      let query = supabase
        .from("execution_plans")
        .select("*")
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (status) query = query.eq("status", status);

      const { data, error } = await query;
      if (error) {
        logger.error("Execution-plans query error", error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data || []));
    })();
    return;
  }

  if (url.pathname.startsWith("/api/execution-plans/") && req.method === "GET") {
    (async () => {
      if (!supabase) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Supabase not configured" }));
        return;
      }
      const planId = url.pathname.split("/api/execution-plans/")[1];
      const { data, error } = await supabase
        .from("execution_plans")
        .select("*")
        .eq("id", planId)
        .single();

      if (error || !data) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    })();
    return;
  }

  // Close a specific conversation by ID
  if (url.pathname === "/api/conversation/close" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        if (!supabase) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Supabase not configured" }));
          return;
        }
        const data = body ? JSON.parse(body) : {};
        if (data.conversation_id) {
          await closeConversation(supabase, data.conversation_id);
        } else if (data.channel) {
          await closeActiveConversation(supabase, data.channel);
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Provide conversation_id or channel" }));
          return;
        }
        clearContextCache();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        logger.error("Conversation close API error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    });
    return;
  }

  // Get active conversation context for a channel (used by ELLIE-50 classifier)
  if (url.pathname === "/api/conversation/context" && req.method === "GET") {
    (async () => {
      try {
        if (!supabase) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Supabase not configured" }));
          return;
        }
        const channel = url.searchParams.get("channel") || "telegram";
        const context = await getConversationContext(supabase, channel);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, context }));
      } catch (err) {
        logger.error("Conversation context API error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    })();
    return;
  }

  // ELLIE-405: Retrieve a conversation by ID (for agent access to past conversations)
  const convoByIdMatch = url.pathname.match(/^\/api\/conversations\/([0-9a-f-]{36})$/i);
  if (convoByIdMatch && req.method === "GET") {
    const convoId = convoByIdMatch[1];
    (async () => {
      try {
        if (!supabase) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Supabase not configured" }));
          return;
        }

        const format = url.searchParams.get("format") || "full";

        if (format === "text") {
          // Smart-truncated text output via existing getConversationMessages()
          const result = await getConversationMessages(supabase, convoId);
          if (!result.messageCount) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "Conversation not found" }));
            return;
          }
          // Also fetch conversation metadata
          const { data: convo } = await supabase
            .from("conversations")
            .select("id, channel, agent, status, summary, message_count, started_at, ended_at")
            .eq("id", convoId)
            .single();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, conversation: convo, text: result.text }));
          return;
        }

        // Structured JSON output with pagination
        const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
        const offset = Number(url.searchParams.get("offset")) || 0;
        const result = await getConversationById(supabase, convoId, { limit, offset });

        if (!result) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Conversation not found" }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          conversation: result.conversation,
          messages: result.messages,
          pagination: {
            total: result.total,
            limit,
            offset,
            has_more: offset + limit < result.total,
          },
        }));
      } catch (err) {
        logger.error("Conversation by ID API error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    })();
    return;
  }

  // ELLIE-406: On-demand data integrity audit
  if (url.pathname === "/api/audit/data-integrity" && req.method === "GET") {
    (async () => {
      try {
        if (!supabase) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Supabase not configured" }));
          return;
        }
        const days = Math.min(Number(url.searchParams.get("days")) || 7, 30);
        const { runDataIntegrityAudit } = await import("./api/data-integrity-audit.ts");
        const result = await runDataIntegrityAudit(supabase, { lookbackDays: days });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (err) {
        logger.error("Data integrity audit API error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    })();
    return;
  }

  // Extract ideas from recent conversations
  if (url.pathname === "/api/extract-ideas" && req.method === "POST") {
    (async () => {
      try {
        if (!supabase) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Supabase not configured" }));
          return;
        }

        logger.info("Starting idea extraction from last 3 conversations");

        // Fetch last 3 conversations with their messages
        const { data: convos, error: convoErr } = await supabase
          .from("conversations")
          .select("id, summary, started_at, ended_at, channel")
          .order("started_at", { ascending: false })
          .limit(3);

        if (convoErr || !convos?.length) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, ideas: [], message: "No conversations found" }));
          return;
        }

        // Fetch messages for each conversation
        const convoTranscripts: string[] = [];
        for (const convo of convos) {
          const { data: msgs } = await supabase
            .from("messages")
            .select("role, content, created_at")
            .eq("conversation_id", convo.id)
            .order("created_at", { ascending: true });

          const transcript = (msgs || [])
            .map((m: { role: string; content: string; created_at: string }) => `${m.role === "user" ? "Dave" : "Ellie"}: ${m.content}`)
            .join("\n");

          convoTranscripts.push(
            `### Conversation (${convo.channel || "unknown"}, ${convo.started_at})\n` +
            `Summary: ${convo.summary || "No summary"}\n\n` +
            `${transcript || "No messages"}`
          );
        }

        // Fetch open Plane items
        const openItems = await listOpenIssues("ELLIE", 50);
        const openItemsList = openItems.length
          ? openItems.map(i => `- ELLIE-${i.sequenceId}: ${i.name}`).join("\n")
          : "No open items";

        // Build prompt
        const prompt = `You are analyzing recent conversations between Dave and Ellie (an AI assistant) to extract potential work items for the ELLIE project.

## Recent Conversations

${convoTranscripts.join("\n\n---\n\n")}

## Currently Open Work Items

${openItemsList}

Extract actionable ideas (features, bugs, improvements, tasks) mentioned or implied in these conversations. For each idea, check if it matches or overlaps with an existing open item.

Return ONLY valid JSON (no markdown, no explanation) in this format:
{
  "ideas": [
    {
      "title": "Short title for the work item",
      "description": "1-2 sentence description of what needs to be done",
      "existing": "ELLIE-XX" or null
    }
  ]
}

If no actionable ideas are found, return: { "ideas": [] }`;

        // Call Claude CLI — pipe prompt via stdin to avoid E2BIG
        const cliArgs = [CLAUDE_PATH, "-p", "--output-format", "text"];
        const proc = spawn(cliArgs, {
          stdin: new Blob([prompt]),
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, CLAUDECODE: "", ANTHROPIC_API_KEY: "" },
        });

        const TIMEOUT_MS = 90_000;
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          logger.error("CLI timeout — killing");
          proc.kill();
        }, TIMEOUT_MS);

        const output = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        clearTimeout(timeout);

        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          const msg = timedOut ? "timed out" : stderr || `exit code ${exitCode}`;
          throw new Error(`Claude CLI failed: ${msg}`);
        }

        const cleaned = output.trim();

        // Parse JSON (with fallback for CLI preamble)
        let parsed: { ideas: Array<{ title: string; description: string; existing: string | null }> };
        try {
          parsed = JSON.parse(cleaned);
        } catch {
          const jsonMatch = cleaned.match(/\{[\s\S]*"ideas"[\s\S]*\}/);
          if (!jsonMatch) throw new Error("No JSON found in CLI response");
          parsed = JSON.parse(jsonMatch[0]);
        }

        const ideas = parsed.ideas || [];
        logger.info(`Extracted ${ideas.length} ideas`);

        // Send extracted ideas to ellie-chat for interactive triage
        if (ideas.length > 0) {
          const newIdeas = ideas.filter((i: { title: string; description: string; existing: string | null }) => !i.existing);
          const existingIdeas = ideas.filter((i: { title: string; description: string; existing: string | null }) => i.existing);

          let chatMsg = `**Idea Extraction** — ${ideas.length} potential work items\n\n`;
          for (const idea of ideas) {
            const tag = idea.existing ? `[EXISTS: ${idea.existing}]` : "**[NEW]**";
            chatMsg += `${tag} **${idea.title}**\n${idea.description}\n\n`;
          }
          if (newIdeas.length > 0) {
            chatMsg += `\n${newIdeas.length} new idea${newIdeas.length > 1 ? "s" : ""} ready to work — reply to discuss, create tickets, or refine.`;
          }

          // Save as assistant message and broadcast to connected clients
          await saveMessage("assistant", chatMsg.trim(), {}, "ellie-chat");
          const payload = JSON.stringify({
            type: "response",
            text: chatMsg.trim(),
            agent: "general",
            ts: Date.now(),
          });
          for (const ws of ellieChatClients) {
            if (ws.readyState === WebSocket.OPEN) ws.send(payload);
          }
          logger.info(`Sent ${ideas.length} ideas to ellie-chat`, { newIdeas: newIdeas.length, existingIdeas: existingIdeas.length });
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, ideas }));
      } catch (err) {
        logger.error("Extract-ideas error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    })();
    return;
  }

  // Harvest conversation to Forest — extract seeds (new knowledge) and rain (enrichments) (ELLIE-249)
  if (url.pathname === "/api/harvest" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        if (!supabase) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Supabase not configured" }));
          return;
        }

        const data = body ? JSON.parse(body) : {};
        const conversationId = data?.conversation_id;

        if (!conversationId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Missing conversation_id" }));
          return;
        }

        logger.info(`Starting harvest for conversation ${conversationId}`);

        // Fetch conversation metadata
        const { data: convo, error: convoErr } = await supabase
          .from("conversations")
          .select("id, channel, agent, summary, started_at, last_message_at, message_count")
          .eq("id", conversationId)
          .single();

        if (convoErr || !convo) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Conversation not found" }));
          return;
        }

        if ((convo.message_count || 0) < 5) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Conversation too short (need at least 5 messages)" }));
          return;
        }

        // Fetch messages
        const { data: msgs } = await supabase
          .from("messages")
          .select("role, content, created_at")
          .eq("conversation_id", conversationId)
          .order("created_at", { ascending: true });

        if (!msgs?.length) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, seeds: [], rain: [], message: "No messages found" }));
          return;
        }

        const transcript = msgs
          .map((m: { role: string; content: string; created_at: string }) => `${m.role === "user" ? "Dave" : "Ellie"}: ${m.content}`)
          .join("\n");

        // Build extraction prompt
        const prompt = `You are the Conversation Harvester — an agent that extracts institutional knowledge from conversations for storage in the Forest (a knowledge graph).

## Conversation Metadata
- Channel: ${convo.channel || "unknown"}
- Date: ${convo.started_at}
- Messages: ${msgs.length}
- Summary: ${convo.summary || "No summary"}

## Transcript

${transcript}

## Instructions

Extract knowledge candidates from this conversation:

**Seeds** (new knowledge): Decisions with reasoning, findings about codebase/architecture, new facts about the system, hypotheses, new patterns/conventions, new integrations/features added.

**Rain** (enrichment to existing knowledge): Updates to existing decisions, deeper context for known facts, new evidence for/against existing hypotheses.

**Corrections** (user corrected the AI): The user explicitly told the AI it was wrong and provided the correct information. These are the highest-value captures — ground truth from the user. Look for patterns like "no, that's wrong", "actually it's X not Y", "I meant...", or any explicit disagreement where the user provides the right answer.

**Discard** (compost): Greetings, debugging dead-ends, session logistics, repeated info, temporary state.

For each candidate, determine:
- content: Concise, standalone description (must make sense without this conversation)
- type: decision | finding | fact | hypothesis
- scope_path: Which project area (2/1=ellie-dev, 2/2=ellie-forest, 2/3=ellie-home, 2/4=ellie-os-app, 2=all projects)
- confidence: 0.0-1.0 (corrections should be 1.0 since the user stated the correct fact)
- category: seed, rain, or correction
- tags: relevant topic tags (array of strings)

Quality over quantity — 3 high-value entries beat 15 mediocre ones.

Return ONLY valid JSON (no markdown, no explanation):
{
  "candidates": [
    {
      "content": "...",
      "type": "decision|finding|fact|hypothesis",
      "scope_path": "2/1",
      "confidence": 0.85,
      "category": "seed|rain|correction",
      "tags": ["tag1", "tag2"]
    }
  ]
}

If no Forest-worthy knowledge exists, return: { "candidates": [] }`;

        // Call Claude CLI — pipe prompt via stdin to avoid E2BIG
        const cliArgs = [CLAUDE_PATH, "-p", "--output-format", "text"];
        const proc = spawn(cliArgs, {
          stdin: new Blob([prompt]),
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, CLAUDECODE: "", ANTHROPIC_API_KEY: "" },
        });

        const TIMEOUT_MS = 90_000;
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          logger.error("[harvest] CLI timeout — killing");
          proc.kill();
        }, TIMEOUT_MS);

        const output = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        clearTimeout(timeout);

        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          const msg = timedOut ? "timed out" : stderr || `exit code ${exitCode}`;
          throw new Error(`Claude CLI failed: ${msg}`);
        }

        // Parse JSON response
        const cleaned = output.trim();
        let parsed: { candidates: Array<{ content: string; type: string; scope_path: string; confidence: number; category: string; tags?: string[] }> };
        try {
          parsed = JSON.parse(cleaned);
        } catch {
          const jsonMatch = cleaned.match(/\{[\s\S]*"candidates"[\s\S]*\}/);
          if (!jsonMatch) throw new Error("No JSON found in CLI response");
          parsed = JSON.parse(jsonMatch[0]);
        }

        const candidates = parsed.candidates || [];
        const seeds = candidates.filter(c => c.category === "seed");
        const rain = candidates.filter(c => c.category === "rain");
        const corrections = candidates.filter(c => c.category === "correction");
        logger.info(`Extracted ${candidates.length} candidates`, { seeds: seeds.length, rain: rain.length, corrections: corrections.length });

        // Check Forest for duplicates and write results
        const { readMemories, writeMemory } = await import("../../ellie-forest/src/index");
        const written: Array<{ id: string; content: string; type: string; category: string }> = [];

        for (const candidate of candidates) {
          // Check Forest for existing similar knowledge
          const existing = await readMemories({
            query: candidate.content,
            scope_path: candidate.scope_path,
            limit: 3,
          });

          const topMatch = existing[0];
          const isDuplicate = topMatch && (topMatch.similarity ?? 0) > 0.8;

          if (isDuplicate) {
            // Reclassify as rain if it was a seed
            if (candidate.category === "seed") {
              candidate.category = "rain";
            }
            logger.info("Duplicate detected, marking as rain", { similarity: topMatch.similarity?.toFixed(2) });
          }

          // Write to Forest with harvest metadata
          const isCorrection = candidate.category === "correction";
          const memory = await writeMemory({
            content: candidate.content,
            type: isCorrection ? "fact" : candidate.type as "decision" | "finding" | "fact" | "hypothesis",
            scope_path: candidate.scope_path,
            confidence: isCorrection ? 1.0 : candidate.confidence,
            tags: [
              ...(candidate.tags || []),
              `harvest:${candidate.category}`,
              `conversation:${conversationId}`,
              ...(isCorrection ? ["correction:ground_truth", "source:user_correction"] : []),
            ],
            metadata: {
              harvest_source: "dashboard",
              harvest_category: candidate.category,
              conversation_id: conversationId,
              conversation_channel: convo.channel,
              work_item_id: "ELLIE-250",
            },
            category: candidate.category === "rain" ? "work" : "general",
          });

          written.push({
            id: memory.id,
            content: candidate.content,
            type: candidate.type,
            category: candidate.category,
          });
        }

        const seedCount = written.filter(w => w.category === "seed").length;
        const rainCount = written.filter(w => w.category === "rain").length;
        const correctionCount = written.filter(w => w.category === "correction").length;

        logger.info("Harvest complete", { seeds: seedCount, rain: rainCount, corrections: correctionCount });

        // Broadcast to ellie-chat clients
        if (written.length > 0) {
          broadcastToEllieChatClients({
            type: "harvest",
            seeds: seedCount,
            rain: rainCount,
            corrections: correctionCount,
            conversationId,
            items: written,
            ts: Date.now(),
          });
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          seeds: written.filter(w => w.category === "seed"),
          rain: written.filter(w => w.category === "rain"),
          corrections: written.filter(w => w.category === "correction"),
          total: written.length,
        }));
      } catch (err) {
        logger.error("Harvest error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
    });
    return;
  }

  // ── Analytics Module endpoints (ELLIE-321) — extracted to api/routes/analytics.ts ──
  if (await handleAnalyticsRoute(req, res, url, supabase)) return;

  // Memory Module endpoints (ELLIE-323) — extracted to api/routes/memory.ts
  if (await handleMemoryRoute(req, res, url, supabase)) return;

  // Tool approval endpoint (called by PreToolUse hook — ELLIE-213)
  if (url.pathname === "/internal/tool-approval" && req.method === "POST") {
    handleToolApprovalHTTP(req, res);
    return;
  }

  // Skills snapshot endpoint (ELLIE-219 — dashboard reads live skill state)
  if (url.pathname === "/api/skills/snapshot" && req.method === "GET") {
    (async () => {
      try {
        const { loadSkillEntries } = await import("./skills/loader.ts");
        const { filterEligibleSkills } = await import("./skills/eligibility.ts");
        const { getSkillSnapshot } = await import("./skills/snapshot.ts");
        const { SKILL_LIMITS } = await import("./skills/types.ts");

        const allSkills = await loadSkillEntries();
        const eligible = await filterEligibleSkills(allSkills);
        const snapshot = await getSkillSnapshot();
        const eligibleNames = new Set(eligible.map(s => s.name));

        // Build per-requirement met/unmet status for dashboard
        // Fetch credential domains from The Hollow (ELLIE-253)
        let credentialDomains: Set<string> = new Set();
        try {
          const { listCredentialDomains } = await import("../../ellie-forest/src/hollow");
          const domains = await listCredentialDomains();
          credentialDomains = new Set(domains);
        } catch {}

        const skills = allSkills.map(s => {
          const reqs: Array<{ type: string; key: string; met: boolean }> = [];
          if (s.frontmatter.requires?.env) {
            for (const envKey of s.frontmatter.requires.env) {
              reqs.push({ type: "env", key: envKey, met: !!process.env[envKey] });
            }
          }
          if (s.frontmatter.requires?.bins) {
            for (const bin of s.frontmatter.requires.bins) {
              reqs.push({ type: "binary", key: bin, met: true }); // if we got this far, bins were checked
            }
          }
          if (s.frontmatter.requires?.credentials) {
            for (const domain of s.frontmatter.requires.credentials) {
              reqs.push({ type: "credential", key: domain, met: credentialDomains.has(domain) });
            }
          }

          return {
            name: s.name,
            description: s.description,
            eligible: eligibleNames.has(s.name),
            always: s.frontmatter.always || false,
            userInvocable: s.frontmatter.userInvocable || false,
            agent: s.frontmatter.agent || null,
            mcp: s.frontmatter.mcp || null,
            triggers: s.frontmatter.triggers || [],
            requires: reqs.length > 0 ? reqs : null,
            os: s.frontmatter.os || null,
            source: s.sourcePriority === 1 ? "workspace" : s.sourcePriority === 2 ? "personal" : "bundled",
            sourceDir: s.sourceDir,
            charCount: s.instructions.length,
            instructions: s.instructions,
            help: s.frontmatter.help || null,
          };
        });

        res.writeHead(200, { "Content-Type": "application/json", ...corsHeader(req.headers.origin as string | undefined) });
        res.end(JSON.stringify({
          skills,
          stats: {
            total: allSkills.length,
            eligible: eligible.length,
            promptChars: snapshot.totalChars,
            maxChars: SKILL_LIMITS.maxSkillsPromptChars,
            maxSkills: SKILL_LIMITS.maxSkillsInPrompt,
            version: snapshot.version,
          },
        }));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Failed to load skills" }));
      }
    })();
    return;
  }

  // Skill help endpoint (ELLIE-324 — Module Help Icons)
  if (url.pathname.startsWith("/api/skills/") && url.pathname.endsWith("/help") && req.method === "GET") {
    const parts = url.pathname.split("/");
    // /api/skills/<name>/help → parts = ["", "api", "skills", "<name>", "help"]
    const skillName = parts[3];
    if (!skillName) {
      res.writeHead(400, { "Content-Type": "application/json", ...corsHeader(req.headers.origin as string | undefined) });
      res.end(JSON.stringify({ error: "Missing skill name" }));
      return;
    }
    (async () => {
      try {
        const { loadSkillEntries } = await import("./skills/loader.ts");
        const { filterEligibleSkills } = await import("./skills/eligibility.ts");

        const allSkills = await loadSkillEntries();
        const skill = allSkills.find(s => s.name === skillName);

        if (!skill) {
          res.writeHead(404, { "Content-Type": "application/json", ...corsHeader(req.headers.origin as string | undefined) });
          res.end(JSON.stringify({ error: `Skill '${skillName}' not found` }));
          return;
        }

        const eligible = await filterEligibleSkills(allSkills);
        const isEligible = eligible.some(s => s.name === skillName);

        // Build requirement status
        let credentialDomains: Set<string> = new Set();
        try {
          const { listCredentialDomains } = await import("../../ellie-forest/src/hollow");
          const domains = await listCredentialDomains();
          credentialDomains = new Set(domains);
        } catch {}

        const reqs: Array<{ type: string; key: string; met: boolean }> = [];
        if (skill.frontmatter.requires?.env) {
          for (const envKey of skill.frontmatter.requires.env) {
            reqs.push({ type: "env", key: envKey, met: !!process.env[envKey] });
          }
        }
        if (skill.frontmatter.requires?.bins) {
          for (const bin of skill.frontmatter.requires.bins) {
            reqs.push({ type: "binary", key: bin, met: true });
          }
        }
        if (skill.frontmatter.requires?.credentials) {
          for (const domain of skill.frontmatter.requires.credentials) {
            reqs.push({ type: "credential", key: domain, met: credentialDomains.has(domain) });
          }
        }

        res.writeHead(200, { "Content-Type": "application/json", ...corsHeader(req.headers.origin as string | undefined) });
        res.end(JSON.stringify({
          name: skill.name,
          description: skill.description,
          eligible: isEligible,
          triggers: skill.frontmatter.triggers || [],
          userInvocable: skill.frontmatter.userInvocable || false,
          help: skill.frontmatter.help || null,
          requires: reqs.length > 0 ? reqs : null,
          always: skill.frontmatter.always || false,
          mcp: skill.frontmatter.mcp || null,
        }));
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Failed to load skill" }));
      }
    })();
    return;
  }

  // Skill import endpoint (ELLIE-220)
  if (url.pathname === "/api/skills/import" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      (async () => {
        try {
          const data = body ? JSON.parse(body) : {};
          const { bumpSnapshotVersion } = await import("./skills/snapshot.ts");
          const { parseFrontmatter } = await import("./skills/frontmatter.ts");
          const { auditSkill } = await import("./skills/auditor.ts");
          const { join } = await import("path");
          const { mkdir, writeFile } = await import("fs/promises");

          const skillsDir = join(process.cwd(), "skills");
          let skillName: string;
          let files: Array<{ path: string; content: string }> = [];
          let meta: Record<string, unknown> | null = null;
          let skillMdContent = "";

          if (data.zip) {
            // Base64-encoded zip — extract in memory
            const zipBuf = Buffer.from(data.zip, "base64");
            const JSZip = (await import("jszip")).default;
            const zip = await JSZip.loadAsync(zipBuf);

            let skillMd = "";
            const extraFiles: Array<{ path: string; content: string }> = [];

            for (const [name, entry] of Object.entries(zip.files)) {
              if (entry.dir) continue;
              const content = await entry.async("string");
              if (name === "SKILL.md" || name.endsWith("/SKILL.md")) {
                skillMd = content;
              } else if (name === "_meta.json" || name.endsWith("/_meta.json")) {
                try { meta = JSON.parse(content); } catch {}
              } else {
                extraFiles.push({ path: name, content });
              }
            }

            if (!skillMd) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "No SKILL.md found in zip" }));
              return;
            }

            const parsed = parseFrontmatter(skillMd);
            if (!parsed) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Invalid SKILL.md frontmatter" }));
              return;
            }

            skillName = parsed.frontmatter.name;
            skillMdContent = skillMd;
            files.push({ path: "SKILL.md", content: skillMd });
            if (meta) files.push({ path: "_meta.json", content: JSON.stringify(meta, null, 2) });
            files.push(...extraFiles);

          } else if (data.markdown) {
            // Raw markdown paste
            const parsed = parseFrontmatter(data.markdown);
            if (!parsed) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Invalid SKILL.md frontmatter — needs --- name --- block" }));
              return;
            }
            skillName = parsed.frontmatter.name;
            skillMdContent = data.markdown;
            files.push({ path: "SKILL.md", content: data.markdown });

          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Provide 'zip' (base64) or 'markdown' (string)" }));
            return;
          }

          // Sanitize skill name for directory
          const safeName = skillName.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
          const installDir = join(skillsDir, safeName);

          // **SECURITY: Audit skill before installation**
          const extraFiles = files.filter((f) => f.path !== "SKILL.md" && f.path !== "_meta.json");
          const auditReport = await auditSkill(installDir, skillMdContent, extraFiles);

          // Enforce sandbox policy
          if (auditReport.riskRating === "RISKY") {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              error: "Skill audit failed — security risks detected",
              auditReport,
            }));
            return;
          }

          // CAUTION: require explicit acknowledgment from user (could be set via data.bypassCaution flag for automated installs)
          if (auditReport.riskRating === "CAUTION" && !data.acknowledgeCaution) {
            res.writeHead(202, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              message: "Skill audit requires acknowledgment",
              auditReport,
              instruction: "Re-submit with acknowledgeCaution: true to proceed",
            }));
            return;
          }

          // Write all files
          for (const f of files) {
            const filePath = join(installDir, f.path);
            const dir = filePath.substring(0, filePath.lastIndexOf("/"));
            await mkdir(dir, { recursive: true });

            // Replace {baseDir} placeholder with actual install path in text files
            const resolved = f.content.replace(/\{baseDir\}/g, installDir);
            await writeFile(filePath, resolved, "utf-8");
          }

          // Bump snapshot so new skill is picked up
          bumpSnapshotVersion();

          logger.info(`Imported skill "${skillName}"`, { files: files.length, risk: auditReport.riskRating, dir: installDir });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            name: skillName,
            dir: installDir,
            files: files.map(f => f.path),
            meta,
            auditReport,
          }));
        } catch (err: unknown) {
          logger.error("Skills import error", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Failed to import skill" }));
        }
      })();
    });
    return;
  }

  // ── Skill Sandbox endpoints (ELLIE-326) ────────────────────

  // List sandboxed skills
  if (url.pathname === "/api/skills/sandbox" && req.method === "GET") {
    (async () => {
      try {
        const { join } = await import("path");
        const { readdir, readFile, stat } = await import("fs/promises");
        const { parseFrontmatter } = await import("./skills/frontmatter.ts");

        const sandboxDir = join(process.cwd(), "skills-sandbox");
        let entries: string[] = [];
        try { entries = await readdir(sandboxDir); } catch { /* dir may not exist */ }

        const skills: Array<Record<string, unknown>> = [];
        for (const name of entries) {
          const skillDir = join(sandboxDir, name);
          const st = await stat(skillDir).catch(() => null);
          if (!st?.isDirectory()) continue;

          const skillMdPath = join(skillDir, "SKILL.md");
          const skillMd = await readFile(skillMdPath, "utf-8").catch(() => null);
          if (!skillMd) continue;

          const parsed = parseFrontmatter(skillMd);
          // Check for stored audit report
          const reportPath = join(skillDir, "_audit-report.json");
          const report = await readFile(reportPath, "utf-8").then(r => JSON.parse(r)).catch(() => null);

          skills.push({
            dirName: name,
            name: parsed?.frontmatter?.name || name,
            description: parsed?.frontmatter?.description || "",
            triggers: parsed?.frontmatter?.triggers || [],
            auditReport: report,
            uploadedAt: st.mtime.toISOString(),
          });
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ skills }));
      } catch (err: unknown) {
        logger.error("Sandbox list error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Failed to list sandbox" }));
      }
    })();
    return;
  }

  // Upload to sandbox
  if (url.pathname === "/api/skills/sandbox/upload" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      (async () => {
        try {
          const data = body ? JSON.parse(body) : {};
          const { parseFrontmatter } = await import("./skills/frontmatter.ts");
          const { auditSkill } = await import("./skills/auditor.ts");
          const { join } = await import("path");
          const { mkdir, writeFile } = await import("fs/promises");

          const sandboxDir = join(process.cwd(), "skills-sandbox");
          let skillName: string;
          let files: Array<{ path: string; content: string }> = [];
          let skillMdContent = "";

          if (data.zip) {
            const zipBuf = Buffer.from(data.zip, "base64");
            const JSZip = (await import("jszip")).default;
            const zip = await JSZip.loadAsync(zipBuf);

            let skillMd = "";
            const extraFiles: Array<{ path: string; content: string }> = [];

            for (const [name, entry] of Object.entries(zip.files)) {
              if (entry.dir) continue;
              const content = await entry.async("string");
              if (name === "SKILL.md" || name.endsWith("/SKILL.md")) {
                skillMd = content;
              } else {
                extraFiles.push({ path: name, content });
              }
            }

            if (!skillMd) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "No SKILL.md found in zip" }));
              return;
            }

            const parsed = parseFrontmatter(skillMd);
            if (!parsed) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Invalid SKILL.md frontmatter" }));
              return;
            }

            skillName = parsed.frontmatter.name;
            skillMdContent = skillMd;
            files.push({ path: "SKILL.md", content: skillMd });
            files.push(...extraFiles);

          } else if (data.markdown) {
            const parsed = parseFrontmatter(data.markdown);
            if (!parsed) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Invalid SKILL.md frontmatter — needs --- name --- block" }));
              return;
            }
            skillName = parsed.frontmatter.name;
            skillMdContent = data.markdown;
            files.push({ path: "SKILL.md", content: data.markdown });

          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Provide 'zip' (base64) or 'markdown' (string)" }));
            return;
          }

          // Save to sandbox directory
          const safeName = skillName.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
          const installDir = join(sandboxDir, safeName);
          await mkdir(installDir, { recursive: true });

          for (const f of files) {
            const filePath = join(installDir, f.path);
            const dir = filePath.substring(0, filePath.lastIndexOf("/"));
            await mkdir(dir, { recursive: true });
            await writeFile(filePath, f.content, "utf-8");
          }

          // Run audit
          const extraFiles = files.filter(f => f.path !== "SKILL.md");
          const auditReport = await auditSkill(installDir, skillMdContent, extraFiles);

          // Store audit report alongside the skill
          await writeFile(join(installDir, "_audit-report.json"), JSON.stringify(auditReport, null, 2), "utf-8");

          logger.info(`Sandbox upload "${skillName}"`, { files: files.length, risk: auditReport.riskRating, dir: installDir });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            name: skillName,
            dirName: safeName,
            files: files.map(f => f.path),
            auditReport,
          }));
        } catch (err: unknown) {
          logger.error("Sandbox upload error", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Failed to upload to sandbox" }));
        }
      })();
    });
    return;
  }

  // Promote sandbox skill to live
  if (url.pathname.match(/^\/api\/skills\/sandbox\/([^/]+)\/promote$/) && req.method === "POST") {
    const dirName = url.pathname.match(/^\/api\/skills\/sandbox\/([^/]+)\/promote$/)?.[1];
    (async () => {
      try {
        const { join } = await import("path");
        const { readdir, readFile, mkdir, writeFile, rm } = await import("fs/promises");
        const { bumpSnapshotVersion } = await import("./skills/snapshot.ts");

        const sandboxDir = join(process.cwd(), "skills-sandbox", dirName!);
        const targetDir = join(process.cwd(), "skills", dirName!);

        // Read audit report to check rating
        const reportPath = join(sandboxDir, "_audit-report.json");
        const report = await readFile(reportPath, "utf-8").then(r => JSON.parse(r)).catch(() => null);
        if (report?.riskRating === "RISKY") {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Cannot promote RISKY skill — resolve security issues first" }));
          return;
        }

        // Copy all files except _audit-report.json to skills/
        const entries = await readdir(sandboxDir);
        await mkdir(targetDir, { recursive: true });
        for (const entry of entries) {
          if (entry === "_audit-report.json") continue;
          const content = await readFile(join(sandboxDir, entry), "utf-8");
          await writeFile(join(targetDir, entry), content, "utf-8");
        }

        // Remove from sandbox
        await rm(sandboxDir, { recursive: true, force: true });

        // Bump snapshot so skill loads
        bumpSnapshotVersion();

        logger.info(`Promoted "${dirName}" from sandbox to live`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, name: dirName, dir: targetDir }));
      } catch (err: unknown) {
        logger.error("Sandbox promote error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Failed to promote skill" }));
      }
    })();
    return;
  }

  // Delete sandbox skill
  if (url.pathname.match(/^\/api\/skills\/sandbox\/([^/]+)$/) && req.method === "DELETE") {
    const dirName = url.pathname.match(/^\/api\/skills\/sandbox\/([^/]+)$/)?.[1];
    (async () => {
      try {
        const { join } = await import("path");
        const { rm } = await import("fs/promises");

        const sandboxDir = join(process.cwd(), "skills-sandbox", dirName!);
        await rm(sandboxDir, { recursive: true, force: true });

        logger.info(`Deleted sandbox skill "${dirName}"`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (err: unknown) {
        logger.error("Sandbox delete error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Failed to delete sandbox skill" }));
      }
    })();
    return;
  }

  // Work session endpoints
  if (url.pathname.startsWith("/api/work-session/") && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(body);
        } catch (parseErr) {
          logger.error("JSON parse error", { body: body.substring(0, 200) }, parseErr);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
          return;
        }
        const endpoint = url.pathname.replace("/api/work-session/", "");

        // Import work-session handlers
        const { startWorkSession, updateWorkSession, logDecision, completeWorkSession, pauseWorkSession, resumeWorkSession } =
          await import("./api/work-session.ts");

        // Mock req/res objects that match Express signature
        const mockReq: ApiRequest = { body: data };
        const mockRes: ApiResponse = {
          status: (code: number) => ({
            json: (data: unknown) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(data));
            }
          }),
          json: (data: unknown) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        };

        switch (endpoint) {
          case "start":
            await startWorkSession(mockReq, mockRes, bot, supabase);
            break;
          case "update":
            await updateWorkSession(mockReq, mockRes, bot);
            break;
          case "decision":
            await logDecision(mockReq, mockRes, bot);
            break;
          case "complete":
            await completeWorkSession(mockReq, mockRes, bot);
            break;
          case "pause":
            await pauseWorkSession(mockReq, mockRes, bot);
            break;
          case "resume":
            await resumeWorkSession(mockReq, mockRes, bot);
            break;
          default:
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unknown work-session endpoint" }));
        }
      } catch (err) {
        logger.error("Work-session error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
    return;
  }

  // Working Memory API — session-scoped state layer (ELLIE-538)
  if (
    url.pathname.startsWith("/api/working-memory/") &&
    (req.method === "POST" || req.method === "PATCH" || req.method === "GET")
  ) {
    const isGet = req.method === "GET";

    const handleWorkingMemoryRequest = async (body?: string) => {
      let data: Record<string, unknown> = {};
      if (!isGet && body) {
        try {
          data = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
          return;
        }
      }

      const endpoint = url.pathname.replace("/api/working-memory/", "");

      const {
        workingMemoryInitEndpoint,
        workingMemoryUpdateEndpoint,
        workingMemoryReadEndpoint,
        workingMemoryCheckpointEndpoint,
        workingMemoryPromoteEndpoint,
      } = await import("./api/working-memory.ts");

      const queryParams: Record<string, string> = {};
      url.searchParams.forEach((v: string, k: string) => { queryParams[k] = v; });

      const mockReq: ApiRequest = { body: data, query: queryParams };
      const mockRes: ApiResponse = {
        status: (code: number) => ({
          json: (resData: unknown) => {
            res.writeHead(code, { "Content-Type": "application/json" });
            res.end(JSON.stringify(resData));
          },
        }),
        json: (resData: unknown) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(resData));
        },
      };

      switch (endpoint) {
        case "init":
          if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
          await workingMemoryInitEndpoint(mockReq, mockRes);
          break;
        case "update":
          if (req.method !== "PATCH") { res.writeHead(405); res.end(); return; }
          await workingMemoryUpdateEndpoint(mockReq, mockRes);
          break;
        case "read":
          if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
          await workingMemoryReadEndpoint(mockReq, mockRes);
          break;
        case "checkpoint":
          if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
          await workingMemoryCheckpointEndpoint(mockReq, mockRes);
          break;
        case "promote":
          if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
          await workingMemoryPromoteEndpoint(mockReq, mockRes);
          break;
        default:
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unknown working-memory endpoint" }));
      }
    };

    if (isGet) {
      handleWorkingMemoryRequest().catch((err) => {
        logger.error("Working-memory GET error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      });
    } else {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        handleWorkingMemoryRequest(body).catch((err) => {
          logger.error("Working-memory error", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        });
      });
    }
    return;
  }

  // ── ELLIE-633: Search API ───────────────────────────────────
  if (url.pathname === "/api/search" && req.method === "GET") {
    const { searchEndpoint } = await import("./api/search.ts");
    const { supabase } = getRelayDeps();
    const mockReq: ApiRequest = {
      query: Object.fromEntries(url.searchParams.entries()),
    };
    const mockRes: ApiResponse = {
      json: (data: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      },
      status: (code: number) => ({
        json: (data: unknown) => {
          res.writeHead(code, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        },
      }),
    };
    await searchEndpoint(mockReq, mockRes, supabase!);
    return;
  }

  // ── ELLIE-633: Conversation loading API ────────────────────
  if (url.pathname.startsWith("/api/conversations/") && req.method === "GET") {
    const { getConversationEndpoint } = await import("./api/search.ts");
    const { supabase } = getRelayDeps();
    const id = url.pathname.replace("/api/conversations/", "").split("/")[0];
    const mockReq: ApiRequest = {
      params: { id },
      query: Object.fromEntries(url.searchParams.entries()),
    };
    const mockRes: ApiResponse = {
      json: (data: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      },
      status: (code: number) => ({
        json: (data: unknown) => {
          res.writeHead(code, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        },
      }),
    };
    await getConversationEndpoint(mockReq, mockRes, supabase!);
    return;
  }

  // Ellie Chat broadcast endpoint
  if (url.pathname === "/api/ellie-chat/send" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const { message, agent = "general" } = data;

        if (!message) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing required field: message" }));
          return;
        }

        // Broadcast to all connected Ellie Chat clients
        const payload = JSON.stringify({
          type: "response",
          text: message,
          agent,
          ts: Date.now(),
        });

        let sentCount = 0;
        for (const ws of ellieChatClients) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
            sentCount++;
          }
        }

        logger.info(`Broadcast message to ${sentCount} client(s)`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, sent_to: sentCount }));
      } catch (err) {
        logger.error("Ellie-chat error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
    return;
  }

  // Incident response endpoints (ELLIE-89)
  if (url.pathname.startsWith("/api/incident/") && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(body);
        } catch (parseErr) {
          logger.error("JSON parse error", { body: body.substring(0, 200) }, parseErr);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
          return;
        }
        const endpoint = url.pathname.replace("/api/incident/", "");

        const { raiseIncident, updateIncident, resolveIncident } =
          await import("./api/incident.ts");

        const mockReq: ApiRequest = { body: data };
        const mockRes: ApiResponse = {
          status: (code: number) => ({
            json: (data: unknown) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(data));
            }
          }),
          json: (data: unknown) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        };

        switch (endpoint) {
          case "raise":
            await raiseIncident(mockReq, mockRes, bot);
            break;
          case "update":
            await updateIncident(mockReq, mockRes, bot);
            break;
          case "resolve":
            await resolveIncident(mockReq, mockRes, bot);
            break;
          default:
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unknown incident endpoint" }));
        }
      } catch (err) {
        logger.error("Incident error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
    return;
  }

  // Forest shared memory endpoints (ELLIE-90)
  if (url.pathname.startsWith("/api/forest-memory/") && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(body);
        } catch (parseErr) {
          logger.error("JSON parse error", { body: body.substring(0, 200) }, parseErr);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
          return;
        }
        const endpoint = url.pathname.replace("/api/forest-memory/", "");

        const { writeMemoryEndpoint, readMemoryEndpoint, agentContextEndpoint,
          resolveContradictionEndpoint, askCriticEndpoint, creatureWriteMemoryEndpoint,
          arcsEndpoint } =
          await import("./api/memory.ts");

        const mockReq: ApiRequest = { body: data };
        const mockRes: ApiResponse = {
          status: (code: number) => ({
            json: (data: unknown) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(data));
            }
          }),
          json: (data: unknown) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        };

        switch (endpoint) {
          case "write":
            await writeMemoryEndpoint(mockReq, mockRes, bot);
            break;
          case "read":
            await readMemoryEndpoint(mockReq, mockRes, bot);
            break;
          case "context":
            await agentContextEndpoint(mockReq, mockRes, bot);
            break;
          case "resolve":
            await resolveContradictionEndpoint(mockReq, mockRes, bot);
            break;
          case "ask-critic":
            await askCriticEndpoint(mockReq, mockRes, bot);
            break;
          case "creature-write":
            await creatureWriteMemoryEndpoint(mockReq, mockRes, bot);
            break;
          case "arcs":
            await arcsEndpoint(mockReq, mockRes, bot);
            break;
          default:
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unknown forest-memory endpoint" }));
        }
      } catch (err) {
        logger.error("Forest-memory error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
    return;
  }

  // Forest Bridge API — external collaborator endpoints (ELLIE-177)
  if (url.pathname.startsWith("/api/bridge/") && (req.method === "POST" || req.method === "GET")) {
    const isPost = req.method === "POST";

    const handleBridgeRequest = async (body?: string) => {
      try {
        let data: Record<string, unknown> = {};
        if (isPost && body) {
          try {
            data = JSON.parse(body);
          } catch (parseErr) {
            logger.error("JSON parse error", parseErr);
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
            return;
          }
        }

        const endpoint = url.pathname.replace("/api/bridge/", "");

        const {
          bridgeReadEndpoint, bridgeWriteEndpoint,
          bridgeListEndpoint, bridgeScopesEndpoint,
          bridgeWhoamiEndpoint, bridgeTagsEndpoint,
        } = await import("./api/bridge.ts");

        const {
          bridgeRiverSearchEndpoint, bridgeRiverCatalogEndpoint,
          bridgeRiverDocEndpoint, bridgeRiverLinkEndpoint,
          bridgeRiverWriteEndpoint,
        } = await import("./api/bridge-river.ts");

        const queryParams: Record<string, string> = {};
        url.searchParams.forEach((v: string, k: string) => { queryParams[k] = v; });

        const mockReq: ApiRequest = {
          body: data,
          query: queryParams,
          bridgeKey: req.headers["x-bridge-key"] as string,
        };

        const mockRes: ApiResponse = {
          status: (code: number) => ({
            json: (resData: unknown) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(resData));
            },
          }),
          json: (resData: unknown) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(resData));
          },
        };

        switch (endpoint) {
          case "read":
            if (!isPost) { res.writeHead(405); res.end(); return; }
            await bridgeReadEndpoint(mockReq, mockRes);
            break;
          case "write":
            if (!isPost) { res.writeHead(405); res.end(); return; }
            await bridgeWriteEndpoint(mockReq, mockRes);
            break;
          case "list":
            if (isPost) { res.writeHead(405); res.end(); return; }
            await bridgeListEndpoint(mockReq, mockRes);
            break;
          case "scopes":
            if (isPost) { res.writeHead(405); res.end(); return; }
            await bridgeScopesEndpoint(mockReq, mockRes);
            break;
          case "whoami":
            if (isPost) { res.writeHead(405); res.end(); return; }
            await bridgeWhoamiEndpoint(mockReq, mockRes);
            break;
          case "tags":
            if (isPost) { res.writeHead(405); res.end(); return; }
            await bridgeTagsEndpoint(mockReq, mockRes);
            break;
          case "river/search":
            if (!isPost) { res.writeHead(405); res.end(); return; }
            await bridgeRiverSearchEndpoint(mockReq, mockRes);
            break;
          case "river/catalog":
            if (isPost) { res.writeHead(405); res.end(); return; }
            await bridgeRiverCatalogEndpoint(mockReq, mockRes);
            break;
          case "river/doc":
            if (isPost) { res.writeHead(405); res.end(); return; }
            await bridgeRiverDocEndpoint(mockReq, mockRes);
            break;
          case "river/link":
            if (!isPost) { res.writeHead(405); res.end(); return; }
            await bridgeRiverLinkEndpoint(mockReq, mockRes);
            break;
          case "river/write":
            if (!isPost) { res.writeHead(405); res.end(); return; }
            await bridgeRiverWriteEndpoint(mockReq, mockRes);
            break;
          default:
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unknown bridge endpoint" }));
        }
      } catch (err) {
        logger.error("Bridge error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    };

    if (isPost) {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => handleBridgeRequest(body));
    } else {
      handleBridgeRequest();
    }
    return;
  }

  // App Auth API — phone app onboarding (ELLIE-176)
  if (url.pathname.startsWith("/api/app-auth/") && (req.method === "POST" || req.method === "GET")) {
    const isPost = req.method === "POST";

    const handleAppAuthRequest = async (body?: string) => {
      try {
        let data: Record<string, unknown> = {};
        if (isPost && body) {
          try { data = JSON.parse(body); } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
            return;
          }
        }

        const endpoint = url.pathname.replace("/api/app-auth/", "");

        const {
          sendCodeEndpoint, verifyCodeEndpoint,
          meEndpoint, updateProfileEndpoint,
        } = await import("./api/app-auth.ts");

        const mockReq: ApiRequest & { headers: { authorization: string } } = {
          body: data,
          headers: { authorization: (req.headers["authorization"] || "") as string },
        };

        const mockRes: ApiResponse = {
          status: (code: number) => ({
            json: (resData: unknown) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(resData));
            },
          }),
          json: (resData: unknown) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(resData));
          },
        };

        switch (endpoint) {
          case "send-code":
            if (!isPost) { res.writeHead(405); res.end(); return; }
            await sendCodeEndpoint(mockReq, mockRes);
            break;
          case "verify-code":
            if (!isPost) { res.writeHead(405); res.end(); return; }
            await verifyCodeEndpoint(mockReq, mockRes);
            break;
          case "me":
            if (isPost) { res.writeHead(405); res.end(); return; }
            await meEndpoint(mockReq, mockRes);
            break;
          case "update-profile":
            if (!isPost) { res.writeHead(405); res.end(); return; }
            await updateProfileEndpoint(mockReq, mockRes);
            break;
          default:
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unknown app-auth endpoint" }));
        }
      } catch (err) {
        logger.error("App-auth error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    };

    if (isPost) {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => handleAppAuthRequest(body));
    } else {
      handleAppAuthRequest();
    }
    return;
  }

  // ── Agent Queue API (ELLIE-200) ──────────────────────────────
  if (url.pathname.startsWith("/api/queue/")) {
    const handleQueueRequest = async (body?: string) => {
      try {
        const { createQueueItem, listQueueItems, updateQueueStatus, deleteQueueItem, getQueueStats } = await import("./api/agent-queue.ts");

        let data: Record<string, unknown> = {};
        if (body) { try { data = JSON.parse(body); } catch { /* empty */ } }

        const mockReq: ApiRequest = { body: data };
        const mockRes: ApiResponse = {
          status: (code: number) => ({ json: (d: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); } }),
          json: (d: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); },
        };

        const path = url.pathname.replace("/api/queue/", "");

        if (path === "create" && req.method === "POST") {
          await createQueueItem(mockReq, mockRes);
        } else if (path === "list" && req.method === "GET") {
          await listQueueItems(mockReq, mockRes);
        } else if (path === "stats" && req.method === "GET") {
          await getQueueStats(mockReq, mockRes);
        } else if (path.match(/^[0-9a-f-]+\/status$/) && req.method === "POST") {
          const id = path.replace("/status", "");
          await updateQueueStatus(mockReq, mockRes, id);
        } else if (path.match(/^[0-9a-f-]+$/) && req.method === "DELETE") {
          await deleteQueueItem(mockReq, mockRes, path);
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unknown queue endpoint" }));
        }
      } catch (err) {
        logger.error("Agent-queue error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    };

    if (req.method === "POST" || req.method === "DELETE") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => handleQueueRequest(body));
    } else {
      handleQueueRequest();
    }
    return;
  }

  // Forest ES search, metrics & suggest endpoints (ELLIE-105)
  if (url.pathname.startsWith("/forest/api/") && req.method === "GET") {
    (async () => {
      try {
        const endpoint = url.pathname.replace("/forest/api/", "");
        const { searchForest, getForestMetrics, suggestTreeNames } =
          await import("./elasticsearch/search-forest.ts");
        const { withBreaker } = await import("./elasticsearch/circuit-breaker.ts");

        switch (endpoint) {
          case "search": {
            const q = url.searchParams.get("q") || "";
            if (!q) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Missing required query parameter: q" }));
              return;
            }
            const indices = url.searchParams.get("indices")?.split(",").filter(Boolean) as string[] | undefined;
            const limit = parseInt(url.searchParams.get("limit") || "20", 10);
            const results = await withBreaker(
              () => searchForest(q, {
                indices,
                limit,
                filters: {
                  treeType: url.searchParams.get("types") || undefined,
                  entityName: url.searchParams.get("entities") || undefined,
                  state: url.searchParams.get("states") || undefined,
                  dateFrom: url.searchParams.get("from") || undefined,
                  dateTo: url.searchParams.get("to") || undefined,
                },
              }),
              []
            );
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ results, count: results.length }));
            break;
          }

          case "metrics": {
            const metrics = await withBreaker(
              () => getForestMetrics({
                timeRange: url.searchParams.get("from") && url.searchParams.get("to")
                  ? { from: url.searchParams.get("from")!, to: url.searchParams.get("to")! }
                  : undefined,
                entityNames: url.searchParams.get("entities")?.split(",").filter(Boolean),
              }),
              {
                creaturesByEntity: {}, eventsByKind: {}, treesByType: {},
                creaturesByState: {}, memoriesByType: {}, failureRate: 0,
                totalEvents: 0, totalCreatures: 0, totalTrees: 0, totalMemories: 0,
              }
            );
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(metrics));
            break;
          }

          case "suggest": {
            const q = url.searchParams.get("q") || "";
            if (!q) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Missing required query parameter: q" }));
              return;
            }
            const suggestions = await withBreaker(() => suggestTreeNames(q), []);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ suggestions }));
            break;
          }

          default:
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unknown forest API endpoint" }));
        }
      } catch (err) {
        logger.error("Forest API error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    })();
    return;
  }

  // Identity observability: archetypes list (ELLIE-621)
  if (url.pathname === "/api/archetypes" && req.method === "GET") {
    const { archetypesEndpoint } = await import("./api/identity-endpoints.ts");
    const mockReq: ApiRequest = {};
    const mockRes: ApiResponse = {
      status(code: number) { return { json: (data: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); } }; },
      json(data: unknown) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); },
    };
    archetypesEndpoint(mockReq, mockRes);
    return;
  }

  // Agent registry endpoints (ELLIE-91)
  if (url.pathname.startsWith("/api/agents") || url.pathname === "/api/capabilities") {
    (async () => {
      const queryParams: Record<string, string> = {};
      for (const [k, v] of url.searchParams.entries()) queryParams[k] = v;

      // Extract :name from path: /api/agents/:name or /api/agents/:name/skills
      const pathParts = url.pathname.replace("/api/agents", "").split("/").filter(Boolean);
      const agentName = pathParts[0] || undefined;
      const subResource = pathParts[1] || undefined;

      const mockReq: ApiRequest = { query: { ...queryParams, ...(agentName ? { name: agentName } : {}) }, params: { name: agentName || null } };
      let _statusCode = 200;
      const mockRes: ApiResponse = {
        status(code: number) { _statusCode = code; return { json: (data: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); } }; },
        json(data: unknown) {
          res.writeHead(_statusCode, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        },
      };

      try {
        const { listAgentsEndpoint, getAgentEndpoint, getAgentSkillsEndpoint, findCapabilityEndpoint } =
          await import("./api/agents.ts");

        if (url.pathname === "/api/capabilities") {
          await findCapabilityEndpoint(mockReq, mockRes, supabase, bot);
        } else if (url.pathname === "/api/agents" || url.pathname === "/api/agents/") {
          if (queryParams.q) {
            await findCapabilityEndpoint(mockReq, mockRes, supabase, bot);
          } else {
            await listAgentsEndpoint(mockReq, mockRes, supabase, bot);
          }
        } else if (agentName === "compliance" && req.method === "GET") {
          const { agentComplianceEndpoint } = await import("./api/agent-compliance.ts");
          await agentComplianceEndpoint(mockReq, mockRes);
        } else if (agentName === "bindings" && req.method === "GET") {
          // ELLIE-621: GET /api/agents/bindings
          const { bindingsEndpoint } = await import("./api/identity-endpoints.ts");
          bindingsEndpoint(mockReq, mockRes);
        } else if (subResource === "identity" && req.method === "GET") {
          // ELLIE-621: GET /api/agents/:name/identity
          const { agentIdentityEndpoint } = await import("./api/identity-endpoints.ts");
          agentIdentityEndpoint(mockReq, mockRes);
        } else if (subResource === "skills") {
          await getAgentSkillsEndpoint(mockReq, mockRes, supabase, bot);
        } else if (agentName) {
          await getAgentEndpoint(mockReq, mockRes, supabase, bot);
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unknown agents endpoint" }));
        }
      } catch (err) {
        logger.error("Agents API error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    })();
    return;
  }

  // Vault credential endpoints (ELLIE-32)
  if (url.pathname.startsWith("/api/vault/")) {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        let data: Record<string, unknown> = {};
        if (body) {
          try {
            data = JSON.parse(body);
          } catch (parseErr) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
            return;
          }
        }

        const {
          createVaultCredential, listVaultCredentials, getVaultCredential,
          updateVaultCredential, deleteVaultCredential,
          resolveVaultCredential, authenticatedFetch,
        } = await import("./api/vault.ts");

        // Parse query params for GET requests
        const queryParams: Record<string, string> = {};
        url.searchParams.forEach((v: string, k: string) => { queryParams[k] = v; });

        // Extract ID from path: /api/vault/credentials/:id
        const pathParts = url.pathname.replace("/api/vault/", "").split("/");
        const segment = pathParts[0]; // "credentials", "resolve", or "fetch"
        const id = pathParts[1] || null;

        const mockReq: ApiRequest = { body: data, params: { id }, query: queryParams };
        const mockRes: ApiResponse = {
          status: (code: number) => ({
            json: (data: unknown) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(data));
            }
          }),
          json: (data: unknown) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        };

        if (!supabase) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Database not configured" }));
          return;
        }

        if (segment === "credentials") {
          if (req.method === "POST" && !id) {
            await createVaultCredential(mockReq, mockRes, supabase);
          } else if (req.method === "GET" && !id) {
            await listVaultCredentials(mockReq, mockRes, supabase);
          } else if (req.method === "GET" && id) {
            await getVaultCredential(mockReq, mockRes, supabase);
          } else if (req.method === "PATCH" && id) {
            await updateVaultCredential(mockReq, mockRes, supabase);
          } else if (req.method === "DELETE" && id) {
            await deleteVaultCredential(mockReq, mockRes, supabase);
          } else {
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Method not allowed" }));
          }
        } else if (segment === "resolve" && req.method === "POST") {
          await resolveVaultCredential(mockReq, mockRes, supabase);
        } else if (segment === "fetch" && req.method === "POST") {
          await authenticatedFetch(mockReq, mockRes, supabase);
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unknown vault endpoint" }));
        }
      } catch (err) {
        logger.error("Vault error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
    return;
  }

  // Comms endpoints (ELLIE-318) — extracted to api/routes/comms.ts
  if (await handleCommsRoute(req, res, url, supabase)) return;

  // Calendar Intel endpoints (ELLIE-319) — extracted to api/routes/calendar-intel.ts
  if (await handleCalendarIntelRoute(req, res, url, supabase)) return;

  // Forest Module endpoints (ELLIE-322)
  if (url.pathname === "/api/forest/browse" && req.method === "GET") {
    (async () => {
      try {
        const queryParams: Record<string, string> = {};
        url.searchParams.forEach((v, k) => { queryParams[k] = v; });
        const { browse } = await import("./api/forest.ts");
        const mockRes: ApiResponse = {
          status: (code: number) => ({ json: (data: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); } }),
          json: (data: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
        };
        await browse({ query: queryParams }, mockRes);
      } catch (err) { logger.error("Forest browse error", err); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
    })();
    return;
  }

  if (url.pathname === "/api/forest/search" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const { search } = await import("./api/forest.ts");
        const mockRes: ApiResponse = {
          status: (code: number) => ({ json: (data: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); } }),
          json: (data: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
        };
        await search({ body: data }, mockRes);
      } catch (err) { logger.error("Forest search error", err); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
    });
    return;
  }

  if (url.pathname === "/api/forest/scopes" && req.method === "GET") {
    (async () => {
      try {
        const { getScopeTree } = await import("./api/forest.ts");
        const mockRes: ApiResponse = {
          status: (code: number) => ({ json: (data: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); } }),
          json: (data: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
        };
        await getScopeTree({}, mockRes);
      } catch (err) { logger.error("Forest scopes error", err); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
    })();
    return;
  }

  if (url.pathname === "/api/forest/timeline" && req.method === "GET") {
    (async () => {
      try {
        const queryParams: Record<string, string> = {};
        url.searchParams.forEach((v, k) => { queryParams[k] = v; });
        const { getTimeline } = await import("./api/forest.ts");
        const mockRes: ApiResponse = {
          status: (code: number) => ({ json: (data: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); } }),
          json: (data: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
        };
        await getTimeline({ query: queryParams }, mockRes);
      } catch (err) { logger.error("Forest timeline error", err); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
    })();
    return;
  }

  if (url.pathname === "/api/forest/tags" && req.method === "GET") {
    (async () => {
      try {
        const queryParams: Record<string, string> = {};
        url.searchParams.forEach((v, k) => { queryParams[k] = v; });
        const { getTags } = await import("./api/forest.ts");
        const mockRes: ApiResponse = {
          status: (code: number) => ({ json: (data: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); } }),
          json: (data: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
        };
        await getTags({ query: queryParams }, mockRes);
      } catch (err) { logger.error("Forest tags error", err); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
    })();
    return;
  }

  if (url.pathname === "/api/forest/contradictions" && req.method === "GET") {
    (async () => {
      try {
        const { getContradictions } = await import("./api/forest.ts");
        const mockRes: ApiResponse = {
          status: (code: number) => ({ json: (data: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); } }),
          json: (data: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
        };
        await getContradictions({}, mockRes);
      } catch (err) { logger.error("Forest contradictions error", err); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
    })();
    return;
  }

  if (url.pathname === "/api/forest/batch" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const { batchRetrieve } = await import("./api/forest.ts");
        const mockRes: ApiResponse = {
          status: (code: number) => ({ json: (data: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); } }),
          json: (data: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
        };
        await batchRetrieve({ body: data }, mockRes);
      } catch (err) { logger.error("Forest batch error", err); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
    });
    return;
  }

  // /api/forest/memory/:id and /api/forest/memory/:id/related
  const forestMemoryMatch = url.pathname.match(/^\/api\/forest\/memory\/([0-9a-f-]+)(\/(\S+))?$/);
  if (forestMemoryMatch) {
    const memoryId = forestMemoryMatch[1];
    const action = forestMemoryMatch[3];

    if (!action && req.method === "GET") {
      (async () => {
        try {
          const { getMemoryDetail } = await import("./api/forest.ts");
          const mockRes: ApiResponse = {
            status: (code: number) => ({ json: (data: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); } }),
            json: (data: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
          };
          await getMemoryDetail({ params: { id: memoryId } }, mockRes);
        } catch (err) { logger.error("Forest memory detail error", err); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
      })();
      return;
    }

    if (action === "related" && req.method === "GET") {
      (async () => {
        try {
          const queryParams: Record<string, string> = {};
          url.searchParams.forEach((v, k) => { queryParams[k] = v; });
          const { getRelatedMemories } = await import("./api/forest.ts");
          const mockRes: ApiResponse = {
            status: (code: number) => ({ json: (data: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); } }),
            json: (data: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
          };
          await getRelatedMemories({ params: { id: memoryId }, query: queryParams }, mockRes);
        } catch (err) { logger.error("Forest related memories error", err); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
      })();
      return;
    }
  }

  // /api/forest/scope/:path/stats (path can contain slashes)
  const forestScopeMatch = url.pathname.match(/^\/api\/forest\/scope\/(.+)\/stats$/);
  if (forestScopeMatch && req.method === "GET") {
    const scopePath = forestScopeMatch[1];
    (async () => {
      try {
        const { getScopeStats } = await import("./api/forest.ts");
        const mockRes: ApiResponse = {
          status: (code: number) => ({ json: (data: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); } }),
          json: (data: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); }
        };
        await getScopeStats({ params: { path: scopePath } }, mockRes);
      } catch (err) { logger.error("Forest scope stats error", err); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
    })();
    return;
  }

  // ELLIE-437: GET /api/forest/branches?tree_id=&prefix= — list branches by prefix
  if (url.pathname === "/api/forest/branches" && req.method === "GET") {
    const treeId = url.searchParams.get("tree_id");
    const prefix = url.searchParams.get("prefix") ?? undefined;
    if (!treeId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "tree_id required" }));
      return;
    }
    (async () => {
      try {
        const { listBranches, getLatestCommit } = await import("../../ellie-forest/src/index.ts");
        const branches = await listBranches(treeId, prefix);
        const results = await Promise.all(branches.map(async (b) => {
          const commit = await getLatestCommit(b.id);
          return { branch_id: b.id, branch_name: b.name, content: commit?.content_summary ?? null };
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ branches: results }));
      } catch (err) { logger.error("Forest branches GET error", err); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
    })();
    return;
  }

  // ELLIE-437: POST /api/forest/reload-profiles — invalidate agent profile cache
  if (url.pathname === "/api/forest/reload-profiles" && req.method === "POST") {
    (async () => {
      try {
        const { invalidateProfileCache } = await import("./agent-profile-builder.ts");
        invalidateProfileCache();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ confirmed: true }));
      } catch (err) { logger.error("Reload profiles error", err); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
    })();
    return;
  }

  // ELLIE-436: GET /api/forest/branch?tree_id=&name= — read branch content
  if (url.pathname === "/api/forest/branch" && req.method === "GET") {
    const treeId = url.searchParams.get("tree_id");
    const branchName = url.searchParams.get("name");
    if (!treeId || !branchName) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "tree_id and name required" }));
      return;
    }
    (async () => {
      try {
        const { getBranchByName, getLatestCommit } = await import("../../ellie-forest/src/index.ts");
        const branch = await getBranchByName(treeId, branchName);
        if (!branch) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Branch not found" }));
          return;
        }
        const commit = await getLatestCommit(branch.id);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ branch_id: branch.id, branch_name: branch.name, content: commit?.content_summary ?? null, commit_id: commit?.id ?? null }));
      } catch (err) { logger.error("Forest branch GET error", err); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
    })();
    return;
  }

  // ELLIE-436: PATCH /api/forest/branch — write new commit to branch, invalidate cache
  if (url.pathname === "/api/forest/branch" && req.method === "PATCH") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const { tree_id, branch_name, content } = JSON.parse(body) as { tree_id: string; branch_name: string; content: string };
        if (!tree_id || !branch_name || content === undefined) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "tree_id, branch_name and content required" }));
          return;
        }
        const { getBranchByName, addCommit } = await import("../../ellie-forest/src/index.ts");
        const branch = await getBranchByName(tree_id, branch_name);
        if (!branch) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Branch not found" }));
          return;
        }
        const commit = await addCommit({ tree_id, branch_id: branch.id, message: "Updated via dashboard", content_summary: content });
        try { const { invalidateProfileCache } = await import("./agent-profile-builder.ts"); invalidateProfileCache(); } catch { /* non-fatal */ }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ commit_id: commit.id, branch_id: branch.id }));
      } catch (err) { logger.error("Forest branch PATCH error", err); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
    });
    return;
  }

  // Relationship Tracker endpoints (ELLIE-320) — extracted to api/routes/relationships.ts
  if (await handleRelationshipsRoute(req, res, url, supabase)) return;

  // Briefing endpoints (ELLIE-316) — extracted to api/routes/briefing.ts
  if (await handleBriefingRoute(req, res, url, supabase, bot)) return;

  // Work Item Gardener endpoints (ELLIE-407)
  if (url.pathname === "/api/work-item-gardener/run" && req.method === "POST") {
    (async () => {
      try {
        const { workItemGardenerRunHandler } = await import("./api/work-item-gardener.ts");
        await workItemGardenerRunHandler(req, res);
      } catch (err) { logger.error("Work item gardener run error", err); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
    })();
    return;
  }

  if (url.pathname === "/api/work-item-gardener/findings" && req.method === "GET") {
    (async () => {
      try {
        const { workItemGardenerFindingsHandler } = await import("./api/work-item-gardener.ts");
        await workItemGardenerFindingsHandler(req, res);
      } catch (err) { logger.error("Work item gardener findings error", err); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
    })();
    return;
  }

  // Commitment Tracker endpoints (ELLIE-339)
  if (url.pathname === "/api/commitments" && req.method === "GET") {
    (async () => {
      try {
        const { commitmentsListHandler } = await import("./api/commitment-tracker.ts");
        await commitmentsListHandler(req, res);
      } catch (err) { logger.error("Commitments list error", err); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
    })();
    return;
  }

  if (url.pathname === "/api/commitments/dismiss" && req.method === "POST") {
    (async () => {
      try {
        const { commitmentsDismissHandler } = await import("./api/commitment-tracker.ts");
        await commitmentsDismissHandler(req, res);
      } catch (err) { logger.error("Commitments dismiss error", err); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
    })();
    return;
  }

  // Cognitive Load Detection endpoints (ELLIE-338)
  if (url.pathname === "/api/cognitive-load/detect" && req.method === "POST") {
    (async () => {
      try {
        const { cognitiveLoadDetectHandler } = await import("./api/cognitive-load.ts");
        await cognitiveLoadDetectHandler(req, res);
      } catch (err) { logger.error("Cognitive load detect error", err); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
    })();
    return;
  }

  if (url.pathname === "/api/cognitive-load/status" && req.method === "GET") {
    (async () => {
      try {
        const { cognitiveLoadStatusHandler } = await import("./api/cognitive-load.ts");
        await cognitiveLoadStatusHandler(req, res);
      } catch (err) { logger.error("Cognitive load status error", err); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
    })();
    return;
  }

  // Channel Gardener endpoints (ELLIE-335)
  if (url.pathname === "/api/channel-gardener/run" && req.method === "POST") {
    (async () => {
      try {
        const { gardenerRunHandler } = await import("./api/channel-gardener.ts");
        await gardenerRunHandler(req, res);
      } catch (err) { logger.error("Channel gardener run error", err); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
    })();
    return;
  }

  if (url.pathname === "/api/channel-gardener/suggestions" && req.method === "GET") {
    (async () => {
      try {
        const { gardenerSuggestionsHandler } = await import("./api/channel-gardener.ts");
        await gardenerSuggestionsHandler(req, res);
      } catch (err) { logger.error("Channel gardener suggestions error", err); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
    })();
    return;
  }

  if (url.pathname.startsWith("/api/channel-gardener/suggestions/") && req.method === "POST") {
    const parts = url.pathname.split("/");
    // /api/channel-gardener/suggestions/{id}/approve|dismiss  → parts[4]=id parts[5]=action
    const suggestionId = parts[4];
    const action = parts[5] as "approve" | "dismiss";
    if (suggestionId && (action === "approve" || action === "dismiss")) {
      (async () => {
        try {
          const { gardenerActionHandler } = await import("./api/channel-gardener.ts");
          await gardenerActionHandler(req, res, suggestionId, action);
        } catch (err) { logger.error("Channel gardener action error", err); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
      })();
      return;
    }
  }

  // Job Intelligence endpoints (ELLIE-456)
  if (url.pathname === "/api/job-intelligence/run" && req.method === "POST") {
    (async () => {
      try {
        const { jobIntelligenceRunHandler } = await import("./api/job-intelligence.ts");
        await jobIntelligenceRunHandler(req, res);
      } catch (err) { logger.error("Job intelligence run error", err); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
    })();
    return;
  }

  if (url.pathname === "/api/job-intelligence/patterns" && req.method === "GET") {
    (async () => {
      try {
        const { jobPatternsHandler } = await import("./api/job-intelligence.ts");
        await jobPatternsHandler(req, res);
      } catch (err) { logger.error("Job patterns fetch error", err); res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Internal server error" })); }
    })();
    return;
  }

  // Alert endpoints (ELLIE-317) — extracted to api/routes/alerts.ts
  if (await handleAlertsRoute(req, res, url, supabase)) return;

  // Rollup endpoints
  if (url.pathname.startsWith("/api/rollup/") && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const endpoint = url.pathname.replace("/api/rollup/", "");

        const { generateRollup } = await import("./api/rollup.ts");

        const mockReq: ApiRequest = { body: data };
        const mockRes: ApiResponse = {
          status: (code: number) => ({
            json: (data: unknown) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(data));
            }
          }),
          json: (data: unknown) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        };

        if (!supabase) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Database not configured" }));
          return;
        }

        switch (endpoint) {
          case "generate":
            await generateRollup(mockReq, mockRes, supabase, bot);
            break;
          case "latest": {
            const { getLatestRollup } = await import("./api/rollup.ts");
            await getLatestRollup(mockReq, mockRes, supabase);
            break;
          }
          default: {
            // Check for /api/rollup/YYYY-MM-DD
            if (/^\d{4}-\d{2}-\d{2}$/.test(endpoint)) {
              const { getRollupByDate } = await import("./api/rollup.ts");
              const dateReq: ApiRequest = { body: data, params: { date: endpoint } };
              await getRollupByDate(dateReq, mockRes, supabase);
            } else {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Unknown rollup endpoint" }));
            }
          }
        }
      } catch (err) {
        logger.error("Rollup error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
    return;
  }

  // Rollup GET endpoints
  if (url.pathname.startsWith("/api/rollup/") && req.method === "GET") {
    (async () => {
      try {
        const endpoint = url.pathname.replace("/api/rollup/", "");

        const mockRes: ApiResponse = {
          status: (code: number) => ({
            json: (data: unknown) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(data));
            }
          }),
          json: (data: unknown) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        };

        if (!supabase) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Database not configured" }));
          return;
        }

        if (endpoint === "latest") {
          const { getLatestRollup } = await import("./api/rollup.ts");
          await getLatestRollup({} as ApiRequest, mockRes, supabase);
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(endpoint)) {
          const { getRollupByDate } = await import("./api/rollup.ts");
          await getRollupByDate({ params: { date: endpoint } } as ApiRequest, mockRes, supabase);
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unknown rollup endpoint" }));
        }
      } catch (err) {
        logger.error("Rollup error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    })();
    return;
  }

  // Weekly review endpoint
  if (url.pathname === "/api/weekly-review/generate" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const { generateWeeklyReview } = await import("./api/weekly-review.ts");

        const mockReq: ApiRequest = { body: data };
        const mockRes: ApiResponse = {
          status: (code: number) => ({
            json: (data: unknown) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(data));
            }
          }),
          json: (data: unknown) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        };

        if (!supabase) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Database not configured" }));
          return;
        }

        await generateWeeklyReview(mockReq, mockRes, supabase, bot);
      } catch (err) {
        logger.error("Weekly-review error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
    return;
  }

  // Security sweep
  if (url.pathname === "/api/security-sweep" && req.method === "GET") {
    (async () => {
      try {
        const { runSecuritySweep } = await import("../scripts/security-sweep.ts");
        const result = await runSecuritySweep();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        logger.error("Security-sweep error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    })();
    return;
  }

  // ── Outlook email API endpoints ──
  if (url.pathname.startsWith("/api/outlook/")) {
    if (!isOutlookConfigured()) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Outlook not configured" }));
      return;
    }

    const endpoint = url.pathname.replace("/api/outlook/", "");

    if (endpoint === "unread" && req.method === "GET") {
      (async () => {
        try {
          const limit = parseInt(url.searchParams.get("limit") || "10");
          const messages = await outlookListUnread(limit);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ messages }));
        } catch (err: unknown) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      })();
      return;
    }

    if (endpoint === "search" && req.method === "GET") {
      (async () => {
        try {
          const q = url.searchParams.get("q") || "";
          const limit = parseInt(url.searchParams.get("limit") || "10");
          const messages = await outlookSearchMessages(q, limit);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ messages }));
        } catch (err: unknown) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      })();
      return;
    }

    if (endpoint.startsWith("message/") && req.method === "GET") {
      (async () => {
        try {
          const messageId = decodeURIComponent(endpoint.replace("message/", ""));
          const message = await outlookGetMessage(messageId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message }));
        } catch (err: unknown) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      })();
      return;
    }

    if (endpoint === "send" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body);
          await outlookSendEmail(payload);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (err: unknown) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
      return;
    }

    if (endpoint === "reply" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { messageId, comment } = JSON.parse(body);
          await outlookReplyToMessage(messageId, comment);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (err: unknown) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
      return;
    }

    if (endpoint.startsWith("read/") && req.method === "POST") {
      (async () => {
        try {
          const messageId = decodeURIComponent(endpoint.replace("read/", ""));
          await outlookMarkAsRead(messageId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (err: unknown) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      })();
      return;
    }
  }

  // Memory dashboard (static HTML)
  if (url.pathname === "/memory" && req.method === "GET") {
    (async () => {
      try {
        const htmlPath = join(PROJECT_ROOT, "public", "memory-dashboard.html");
        const html = await readFile(htmlPath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      } catch (err) {
        logger.error("Error serving dashboard", err);
        res.writeHead(500);
        res.end("Error loading dashboard");
      }
    })();
    return;
  }

  // Forest UI proxy — forward /forest/* to Nuxt dev server
  if (url.pathname === "/forest" || url.pathname.startsWith("/forest/") || url.pathname.startsWith("/_nuxt/")) {
    const forestPort = process.env.FOREST_UI_PORT || "3002";
    const targetUrl = `http://127.0.0.1:${forestPort}${req.url}`;
    (async () => {
      try {
        const proxyRes = await fetch(targetUrl, {
          method: req.method,
          headers: Object.fromEntries(
            Object.entries(req.headers)
              .filter(([, v]) => v !== undefined)
              .map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v!])
          ),
          body: ['GET', 'HEAD'].includes(req.method || 'GET') ? undefined : req as unknown as BodyInit,
        });
        res.writeHead(proxyRes.status, Object.fromEntries(proxyRes.headers.entries()));
        if (proxyRes.body) {
          const reader = proxyRes.body.getReader();
          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
            res.end();
          };
          pump();
        } else {
          res.end(await proxyRes.text());
        }
      } catch (err) {
        // Nuxt dev server not running — show helpful message
        res.writeHead(502, { "Content-Type": "text/html" });
        res.end(`<html><body style="background:#111;color:#aaa;font-family:monospace;padding:2em">
          <h2>Forest UI not running</h2>
          <p>Start the dev server: <code style="color:#4ade80">cd forest-ui && bun run dev</code></p>
        </body></html>`);
      }
    })();
    return;
  }

  // POST /api/obsidian/restart — restart the ellie-obsidian Docker container
  if (url.pathname === "/api/obsidian/restart" && req.method === "POST") {
    (async () => {
      try {
        const proc = spawn(["docker", "restart", "ellie-obsidian"]);
        const code = await proc.exited;
        if (code !== 0) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `docker restart exited with code ${code}` }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        logger.error("Obsidian restart error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to restart container" }));
      }
    })();
    return;
  }

  res.writeHead(404);
  res.end("Not found");
}
