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
} from "./tts.ts";
import {
  buildPrompt,
  getArchetypeContext,
  getPsyContext,
  getPhaseContext,
  getHealthContext,
  runPostMessageAssessment,
  getPlanningMode,
  setPlanningMode,
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
} from "./message-queue.ts";
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
import {
  routeAndDispatch,
  syncResponse,
  type RouteResult,
} from "./agent-router.ts";
import { getSkillSnapshot } from "./skills/index.ts";
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
import { log } from "./logger.ts";

const logger = log.child("http");

export function handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
  const { bot, anthropic, supabase } = getRelayDeps();

  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // Gateway intake endpoints (ELLIE-151) — forwarded from ellie-gateway
  if (req.method === "POST" && handleGatewayRoute(req, res, url.pathname)) return;

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
        console.log(`[voice] Accepted call from ${params.get("From")}`);
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
    console.log("[voice] TwiML served, connecting media stream...");
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
        const event: GoogleChatEvent = JSON.parse(body);

        // Handle card button clicks (approval actions)
        const cardAction = (event as any)?.chat?.cardClickedPayload ||
          ((event as any)?.type === "CARD_CLICKED" ? event : null);
        if (cardAction) {
          const actionFn = cardAction?.chat?.cardClickedPayload?.action?.actionMethodName ||
            (cardAction as any)?.action?.actionMethodName || "";
          const params = cardAction?.chat?.cardClickedPayload?.action?.parameters ||
            (cardAction as any)?.action?.parameters || [];
          const actionId = params.find((p: any) => p.key === "action_id")?.value;

          if (actionId && (actionFn === "approve_action" || actionFn === "deny_action")) {
            const pending = getPendingAction(actionId);
            if (pending) {
              const approved = actionFn === "approve_action";
              removePendingAction(actionId);
              console.log(`[gchat] Action ${approved ? "approved" : "denied"}: ${pending.description.substring(0, 60)}`);

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
                console.log(`[gchat] Approval follow-up sent: ${cleanFollowUp.substring(0, 80)}...`);
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
          console.log(`[gchat] Unauthorized sender: ${parsed.senderEmail}`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
          return;
        }

        console.log(`[gchat] ${parsed.senderName}: ${parsed.text.substring(0, 80)}...`);
        acknowledgeChannel("google-chat"); // User responded — clear pending responses

        await saveMessage("user", parsed.text, {
          sender: parsed.senderEmail,
          space: parsed.spaceName,
        }, "google-chat", parsed.senderEmail);
        broadcastExtension({ type: "message_in", channel: "google-chat", preview: parsed.text.substring(0, 200) });

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

        // Immediately acknowledge — all routing + Claude work happens async.
        // This prevents Google Chat's ~30s webhook timeout from showing "not responding".
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          hostAppDataAction: { chatDataAction: { createMessageAction: { message: { text: "Working on it..." } } } },
        }));

        // All remaining work is async — response delivered via Chat API
        (async () => {
          try {
            const gchatWorkItem = parsed.text.match(/\b([A-Z]+-\d+)\b/)?.[1];
            const gchatAgentResult = await routeAndDispatch(supabase, parsed.text, "google-chat", parsed.senderEmail, gchatWorkItem);
            const effectiveGchatText = gchatAgentResult?.route.strippedMessage || parsed.text;
            if (gchatAgentResult) {
              setActiveAgent("google-chat", gchatAgentResult.dispatch.agent.name);
              broadcastExtension({ type: "route", channel: "google-chat", agent: gchatAgentResult.dispatch.agent.name, mode: gchatAgentResult.route.execution_mode });

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
              acknowledgeQueueItems(gchatActiveAgent).catch(() => {});
            }

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
                  contextDocket, relevantContext, elasticContext,
                  structuredContext, recentMessages, workItemContext, forestContext,
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
                syncResponse(supabase, result.finalDispatch.session_id, gchatClean, {
                  duration_ms: result.artifacts.total_duration_ms,
                }).catch(() => {});
              }

              console.log(`[gchat] ${gchatExecMode}: ${result.stepResults.length} steps in ${result.artifacts.total_duration_ms}ms, $${result.artifacts.total_cost_usd.toFixed(4)}`);

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
                executePlaybookCommands(gchatOrcPlaybookCmds, pbCtx).catch(err => logger.error("Playbook execution failed", err));
              }
              return;
            }

            // ── Google Chat single-agent path (default) ──
            const enrichedPrompt = buildPrompt(
              effectiveGchatText, contextDocket, relevantContext, elasticContext, "google-chat",
              gchatAgentResult?.dispatch.agent ? { system_prompt: gchatAgentResult.dispatch.agent.system_prompt, name: gchatAgentResult.dispatch.agent.name, tools_enabled: gchatAgentResult.dispatch.agent.tools_enabled } : undefined,
              workItemContext || undefined, structuredContext, recentMessages,
              gchatAgentResult?.dispatch.skill_context,
              forestContext,
              agentMemory.memoryContext || undefined,
              agentMemory.sessionIds,
              await getArchetypeContext(),
              await getPsyContext(),
              await getPhaseContext(),
              await getHealthContext(),
              gchatQueueContext || undefined,
              liveForest.incidents || undefined,
              liveForest.awareness || undefined,
              (await getSkillSnapshot()).prompt || undefined,
            );

            const gchatAgentTools = gchatAgentResult?.dispatch.agent.tools_enabled;
            const gchatAgentModel = gchatAgentResult?.dispatch.agent.model;

            const gchatStart = Date.now();
            const rawResponse = await callClaude(enrichedPrompt, {
              resume: true,
              allowedTools: gchatAgentTools?.length ? gchatAgentTools : undefined,
              model: gchatAgentModel || undefined,
            });
            const gchatDuration = Date.now() - gchatStart;
            const response = await processMemoryIntents(supabase, rawResponse, gchatAgentResult?.dispatch.agent.name || "general", "shared", agentMemory.sessionIds);
            const { cleanedText: gchatPlaybookClean, commands: gchatPlaybookCmds } = extractPlaybookCommands(response);

            if (gchatAgentResult) {
              syncResponse(supabase, gchatAgentResult.dispatch.session_id, gchatPlaybookClean, {
                duration_ms: gchatDuration,
              }).catch(() => {});
            }

            const { cleanedText: gchatClean } = extractApprovalTags(gchatPlaybookClean);
            const msgId = await saveMessage("assistant", gchatClean, { space: parsed.spaceName }, "google-chat", parsed.senderEmail);
            broadcastExtension({ type: "message_out", channel: "google-chat", agent: gchatAgentResult?.dispatch.agent.name || "general", preview: gchatClean.substring(0, 200) });
            resetGchatIdleTimer();
            console.log(`[gchat] Async reply (${gchatClean.length} chars) to ${parsed.spaceName}: ${gchatClean.substring(0, 80)}...`);

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
              console.log(`[gchat] Async delivery complete → ${gchatDeliverResult.externalId}`);
            } else if (gchatDeliverResult.status === "fallback") {
              console.log(`[gchat] Async delivery via fallback (${gchatDeliverResult.channel}) → ${gchatDeliverResult.externalId}`);
            } else {
              logger.error("Async delivery failed", { error: gchatDeliverResult.error });
            }

            // Fire playbook commands async (ELLIE:: tags)
            if (gchatPlaybookCmds.length > 0) {
              const pbCtx: PlaybookContext = { bot, supabase, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, channel: "google-chat", callClaudeFn: callClaude, buildPromptFn: buildPrompt };
              executePlaybookCommands(gchatPlaybookCmds, pbCtx).catch(err => logger.error("Playbook execution failed", err));
            }
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
        })();

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

  // Alexa Custom Skill webhook
  if (url.pathname === "/alexa" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        // Verify Alexa request signature (skip in dev if headers missing)
        const certUrl = req.headers["signaturecertchainurl"] as string;
        const signature = req.headers["signature-256"] as string;

        if (certUrl && signature) {
          const { verifyAlexaRequest } = await import("./alexa.ts");
          const valid = await verifyAlexaRequest(certUrl, signature, body);
          if (!valid) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid signature" }));
            return;
          }
        }

        const {
          parseAlexaRequest, handleAddTodo, handleGetTodos, handleGetBriefing,
          buildAlexaResponse, buildAlexaErrorResponse, textToSsml,
        } = await import("./alexa.ts");

        const alexaBody = JSON.parse(body);
        const parsed = parseAlexaRequest(alexaBody);

        console.log(`[alexa] ${parsed.type} ${parsed.intentName || ""}: ${parsed.text.substring(0, 80)}`);

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
            const agentResult = await routeAndDispatch(supabase, query, "alexa", parsed.userId, alexaWorkItem);
            if (agentResult) {
              setActiveAgent("alexa", agentResult.dispatch.agent.name);
              broadcastExtension({ type: "route", channel: "alexa", agent: agentResult.dispatch.agent.name, mode: agentResult.route.execution_mode });
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
              acknowledgeQueueItems(alexaActiveAgent).catch(() => {});
            }
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
              await getArchetypeContext(),
              await getPsyContext(),
              await getPhaseContext(),
              await getHealthContext(),
              alexaQueueContext || undefined,
              liveForest.incidents || undefined,
              liveForest.awareness || undefined,
              (await getSkillSnapshot()).prompt || undefined,
            );

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

  // Health check
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      service: "ellie-relay",
      voice: !!ELEVENLABS_API_KEY,
      googleChat: isGoogleChatEnabled(),
      alexa: true,
    }));
    return;
  }

  // Queue status — returns current processing state and queued items
  if (url.pathname === "/queue-status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getQueueStatus()));
    return;
  }

  // TTS endpoint — returns OGG audio for dashboard playback
  if (url.pathname === "/api/tts" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const authKey = req.headers["x-api-key"] as string;
        if (!authKey || authKey !== EXTENSION_API_KEY || !EXTENSION_API_KEY) {
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
        const audioBuffer = fast
          ? await textToSpeechFast(data.text)
          : await textToSpeechOgg(data.text);
        if (!audioBuffer) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "TTS unavailable" }));
          return;
        }
        const contentType = fast ? "audio/mpeg" : "audio/ogg";
        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": audioBuffer.length.toString(),
        });
        res.end(audioBuffer);
      } catch (err: any) {
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
        const authKey = req.headers["x-api-key"] as string;
        if (!authKey || authKey !== EXTENSION_API_KEY || !EXTENSION_API_KEY) {
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
      } catch (err: any) {
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
        } catch (err: any) {
          const msg = err?.message || String(err);
          let status = "error";
          if (msg.includes("credit balance")) status = "low_credits";
          else if (err?.status === 401) status = "invalid_key";
          result.anthropic = { status, latency_ms: Date.now() - start, error: msg };
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    })();
    return;
  }

  // GTD — return pending Google Tasks as JSON
  if (url.pathname === "/api/gtd" && req.method === "GET") {
    (async () => {
      try {
        const data = await getGoogleTasksJSON();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "Failed to fetch tasks" }));
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
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "Sync failed" }));
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
        console.log(`[consolidate] Manual trigger via API${channel ? ` (channel: ${channel})` : ""}`);
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
            contextParts.push("MEMORIES:\n" + mems.map((m: any) => `[${m.type}] ${m.content}`).join("\n"));
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

        console.log(`[ticket] Generating ticket from ${contextParts.length} context source(s)...`);
        const raw = await callClaude(prompt);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("Could not parse ticket JSON from Claude response");
        const ticket = JSON.parse(jsonMatch[0]);

        if (!ticket.title) throw new Error("Generated ticket has no title");

        const result = await createPlaneIssue("ELLIE", ticket.title, ticket.description, ticket.priority);
        if (!result) throw new Error("Plane API failed to create issue");

        console.log(`[ticket] Created ${result.identifier}: ${ticket.title}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, identifier: result.identifier, title: ticket.title, description: ticket.description }));
      } catch (err: any) {
        logger.error("Ticket creation error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "Failed to create ticket" }));
      }
    });
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

  // Extract ideas from recent conversations
  if (url.pathname === "/api/extract-ideas" && req.method === "POST") {
    (async () => {
      try {
        if (!supabase) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Supabase not configured" }));
          return;
        }

        console.log("[extract-ideas] Starting idea extraction from last 3 conversations");

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
            .map((m: any) => `${m.role === "user" ? "Dave" : "Ellie"}: ${m.content}`)
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

        // Call Claude CLI
        const cliArgs = [CLAUDE_PATH, "-p", prompt, "--output-format", "text"];
        const proc = spawn(cliArgs, {
          stdin: "ignore",
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
        console.log(`[extract-ideas] Extracted ${ideas.length} ideas`);

        // Send extracted ideas to ellie-chat for interactive triage
        if (ideas.length > 0) {
          const newIdeas = ideas.filter((i: any) => !i.existing);
          const existingIdeas = ideas.filter((i: any) => i.existing);

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
          console.log(`[extract-ideas] Sent ${ideas.length} ideas to ellie-chat (${newIdeas.length} new, ${existingIdeas.length} existing)`);
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

  // Memory analytics endpoints (GET requests)
  if (url.pathname.startsWith("/api/memory/") && req.method === "GET") {
    (async () => {
      try {
        const { handleGetStats, handleGetTimeline, handleGetByAgent } =
          await import("./api/memory-analytics.ts");

        // Parse query params
        const queryParams: Record<string, string> = {};
        url.searchParams.forEach((v, k) => { queryParams[k] = v; });

        // Extract endpoint and params
        const pathParts = url.pathname.replace("/api/memory/", "").split("/");
        const endpoint = pathParts[0]; // "stats", "timeline", or "by-agent"
        const param = pathParts[1] || null; // agent name for by-agent

        const mockReq = { query: queryParams, params: { agent: param } } as any;
        const mockRes = {
          status: (code: number) => ({
            json: (data: any) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(data));
            }
          }),
          json: (data: any) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        } as any;

        switch (endpoint) {
          case "stats":
            await handleGetStats(mockReq, mockRes);
            break;
          case "timeline":
            await handleGetTimeline(mockReq, mockRes);
            break;
          case "by-agent":
            if (!param) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Missing agent parameter" }));
              return;
            }
            await handleGetByAgent(mockReq, mockRes);
            break;
          default:
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unknown memory endpoint" }));
        }
      } catch (err) {
        logger.error("Memory-analytics error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    })();
    return;
  }

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
        // Fetch vault domains for credential status
        let vaultDomains: Set<string> = new Set();
        try {
          const { data } = await supabase!.from("credentials").select("domain");
          if (data) vaultDomains = new Set(data.map((r: any) => r.domain));
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
              reqs.push({ type: "credential", key: domain, met: vaultDomains.has(domain) });
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

        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
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
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err?.message || "Failed to load skills" }));
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
          const { join } = await import("path");
          const { mkdir, writeFile } = await import("fs/promises");

          const skillsDir = join(process.cwd(), "skills");
          let skillName: string;
          let files: Array<{ path: string; content: string }> = [];
          let meta: Record<string, unknown> | null = null;

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
            files.push({ path: "SKILL.md", content: data.markdown });

          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Provide 'zip' (base64) or 'markdown' (string)" }));
            return;
          }

          // Sanitize skill name for directory
          const safeName = skillName.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
          const installDir = join(skillsDir, safeName);

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

          console.log(`[skills] Imported "${skillName}" (${files.length} files) → ${installDir}`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            name: skillName,
            dir: installDir,
            files: files.map(f => f.path),
            meta,
          }));
        } catch (err: any) {
          logger.error("Skills import error", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err?.message || "Failed to import skill" }));
        }
      })();
    });
    return;
  }

  // Work session endpoints
  if (url.pathname.startsWith("/api/work-session/") && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        let data: any;
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
        const mockReq = { body: data } as any;
        const mockRes = {
          status: (code: number) => ({
            json: (data: any) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(data));
            }
          }),
          json: (data: any) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        } as any;

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

        console.log(`[ellie-chat] Broadcast message to ${sentCount} client(s)`);

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
        let data: any;
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

        const mockReq = { body: data } as any;
        const mockRes = {
          status: (code: number) => ({
            json: (data: any) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(data));
            }
          }),
          json: (data: any) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        } as any;

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
        let data: any;
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

        const mockReq = { body: data } as any;
        const mockRes = {
          status: (code: number) => ({
            json: (data: any) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(data));
            }
          }),
          json: (data: any) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        } as any;

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
        let data: any = {};
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

        const queryParams: Record<string, string> = {};
        url.searchParams.forEach((v, k) => { queryParams[k] = v; });

        const mockReq = {
          body: data,
          query: queryParams,
          bridgeKey: req.headers["x-bridge-key"] as string,
        } as any;

        const mockRes = {
          status: (code: number) => ({
            json: (resData: any) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(resData));
            },
          }),
          json: (resData: any) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(resData));
          },
        } as any;

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
        let data: any = {};
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

        const mockReq = {
          body: data,
          headers: { authorization: req.headers["authorization"] || "" },
        } as any;

        const mockRes = {
          status: (code: number) => ({
            json: (resData: any) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(resData));
            },
          }),
          json: (resData: any) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(resData));
          },
        } as any;

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

        let data: any = {};
        if (body) { try { data = JSON.parse(body); } catch { /* empty */ } }

        const mockReq = { body: data, url: `http://localhost${url.pathname}${url.search}`, headers: req.headers } as any;
        const mockRes = {
          status: (code: number) => ({ json: (d: any) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); } }),
          json: (d: any) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(d)); },
        } as any;

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
            const indices = url.searchParams.get("indices")?.split(",").filter(Boolean) as any;
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
                creaturesByState: {}, failureRate: 0,
                totalEvents: 0, totalCreatures: 0, totalTrees: 0,
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

  // Agent registry endpoints (ELLIE-91)
  if (url.pathname.startsWith("/api/agents") || url.pathname === "/api/capabilities") {
    (async () => {
      const queryParams: Record<string, string> = {};
      for (const [k, v] of url.searchParams.entries()) queryParams[k] = v;

      // Extract :name from path: /api/agents/:name or /api/agents/:name/skills
      const pathParts = url.pathname.replace("/api/agents", "").split("/").filter(Boolean);
      const agentName = pathParts[0] || undefined;
      const subResource = pathParts[1] || undefined;

      const mockReq: any = { query: { ...queryParams, name: agentName }, params: { name: agentName } };
      const mockRes: any = {
        statusCode: 200,
        status(code: number) { this.statusCode = code; return this; },
        json(data: any) {
          res.writeHead(this.statusCode, { "Content-Type": "application/json" });
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
        let data: any = {};
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
        url.searchParams.forEach((v, k) => { queryParams[k] = v; });

        // Extract ID from path: /api/vault/credentials/:id
        const pathParts = url.pathname.replace("/api/vault/", "").split("/");
        const segment = pathParts[0]; // "credentials", "resolve", or "fetch"
        const id = pathParts[1] || null;

        const mockReq = { body: data, params: { id }, query: queryParams } as any;
        const mockRes = {
          status: (code: number) => ({
            json: (data: any) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(data));
            }
          }),
          json: (data: any) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        } as any;

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

  // Rollup endpoints
  if (url.pathname.startsWith("/api/rollup/") && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const endpoint = url.pathname.replace("/api/rollup/", "");

        const { generateRollup } = await import("./api/rollup.ts");

        const mockReq = { body: data } as any;
        const mockRes = {
          status: (code: number) => ({
            json: (data: any) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(data));
            }
          }),
          json: (data: any) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        } as any;

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
              const dateReq = { body: data, params: { date: endpoint } } as any;
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

        const mockRes = {
          status: (code: number) => ({
            json: (data: any) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(data));
            }
          }),
          json: (data: any) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        } as any;

        if (!supabase) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Database not configured" }));
          return;
        }

        if (endpoint === "latest") {
          const { getLatestRollup } = await import("./api/rollup.ts");
          await getLatestRollup({} as any, mockRes, supabase);
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(endpoint)) {
          const { getRollupByDate } = await import("./api/rollup.ts");
          await getRollupByDate({ params: { date: endpoint } } as any, mockRes, supabase);
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

        const mockReq = { body: data } as any;
        const mockRes = {
          status: (code: number) => ({
            json: (data: any) => {
              res.writeHead(code, { "Content-Type": "application/json" });
              res.end(JSON.stringify(data));
            }
          }),
          json: (data: any) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(data));
          }
        } as any;

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
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
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
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
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
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
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
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
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
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
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
        } catch (err: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
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
          body: ['GET', 'HEAD'].includes(req.method || 'GET') ? undefined : req as any,
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

  res.writeHead(404);
  res.end("Not found");
}
