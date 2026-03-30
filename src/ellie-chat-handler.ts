/**
 * Ellie Chat message handler — processes messages from the dashboard WebSocket chat.
 *
 * Extracted from relay.ts — ELLIE-184 Phase 4.
 * Contains handleEllieChatMessage + runSpecialistAsync.
 */

import { writeFile, unlink } from "fs/promises";
import type { SupabaseClient } from "@supabase/supabase-js";
import { join } from "path";
import { WebSocket } from "ws";
import {
  BOT_TOKEN, ALLOWED_USER_ID, GCHAT_SPACE_NOTIFY, UPLOADS_DIR,
  getContextDocket, clearContextCache,
} from "./relay-config.ts";
import {
  getActiveAgent, setActiveAgent,
  wsAppUserMap, ellieChatPhoneHistories, ellieChatClients,
  broadcastExtension, broadcastToEllieChatClients, getRelayDeps, getNotifyCtx, touchPhoneHistory,
} from "./relay-state.ts";
import { resolveEntityName } from "./agent-entity-map.ts";
import { resetEllieChatIdleTimer, resetTelegramIdleTimer, resetGchatIdleTimer } from "./relay-idle.ts";
import { textToSpeechFast } from "./tts.ts";
import {
  buildPrompt,
  runPostMessageAssessment,
  getPlanningMode,
  setPlanningMode,
  USER_NAME,
  getArchetypeContext,
  getAgentArchetype,
  getAgentRoleContext,
  getPsyContext,
  getPhaseContext,
  getHealthContext,
  getCommitmentFollowUpContext,
  getCognitiveLoadContext,
  getLastBuildMetrics,
} from "./prompt-builder.ts";
import { analyzeAndStoreEmpathy } from "./empathy-middleware.ts";
import {
  callClaude,
  callClaudeVoice,
  session,
} from "./claude-cli.ts";
import { enqueueEllieChat } from "./message-queue.ts";
import {
  saveMessage,
  sendWithApprovalsEllieChat,
} from "./message-sender.ts";
import { extractApprovalTags } from "./approval.ts";
import {
  processMemoryIntents,
  getRelevantContext,
  getRelevantFacts,
} from "./memory.ts";
import { searchElastic } from "./elasticsearch.ts";
import { log } from "./logger.ts";
import { deliverResponse, markProcessing, clearProcessing } from "./ws-delivery.ts";
import { runCoordinatorLoop, buildCoordinatorDeps, type CoordinatorPausedState } from "./coordinator.ts";
import { capturePrompt } from "./api/agent-prompts.ts";
import type { FoundationRegistry } from "./foundation-registry.ts";
import { parseFoundationCommand, executeFoundationCommand } from "./foundation-commands.ts";
import { enterDispatchMode, exitDispatchMode } from "./tool-approval.ts";

const logger = log.child("ellie-chat");

// ── ELLIE-1158/1159: Coordinator ask_user pause queue ──────────
// FIFO queue so concurrent coordinators each get their own slot.
// Previously a single global variable — caused responses to route to
// whichever coordinator wrote last instead of the one that asked first.
// ELLIE-1158: Entries older than ASK_USER_STALE_MS are pruned on shift
// to prevent orphaned paused states from being resumed with unrelated messages.

export const ASK_USER_STALE_MS = 5 * 60 * 1000; // 5 minutes

interface PendingAskUserEntry {
  state: CoordinatorPausedState;
  pausedAt: number;
}

const _pendingAskUserQueue: PendingAskUserEntry[] = [];

export { type CoordinatorPausedState } from "./coordinator.ts";

/** Push a paused coordinator state onto the ask_user queue. */
export function pushPendingAskUser(state: CoordinatorPausedState, pausedAt?: number): void {
  _pendingAskUserQueue.push({ state, pausedAt: pausedAt ?? Date.now() });
}

/** Consume the oldest non-stale pending ask_user state (FIFO). Prunes stale entries. Returns null if empty. */
export function shiftPendingAskUser(): CoordinatorPausedState | null {
  const now = Date.now();
  while (_pendingAskUserQueue.length > 0) {
    const entry = _pendingAskUserQueue.shift()!;
    if (now - entry.pausedAt <= ASK_USER_STALE_MS) {
      return entry.state;
    }
    logger.warn("[coordinator] Pruned stale ask_user entry", {
      question: entry.state.question.slice(0, 100),
      ageMs: now - entry.pausedAt,
    });
  }
  return null;
}

/** Number of coordinators currently waiting for a user response (including stale). */
export function getPendingAskUserCount(): number {
  return _pendingAskUserQueue.length;
}

/** Clear all pending ask_user states. For testing only. */
export function clearPendingAskUserQueue(): void {
  _pendingAskUserQueue.length = 0;
}

// ── Lazy Foundation Registry ────────────────────────────────────
let _foundationRegistry: FoundationRegistry | null = null;
async function getFoundationRegistry(): Promise<FoundationRegistry | null> {
  if (_foundationRegistry) return _foundationRegistry;
  try {
    const { supabase } = getRelayDeps();
    if (!supabase) return null;
    const { FoundationRegistry, createSupabaseFoundationStore } = await import("./foundation-registry.ts");
    _foundationRegistry = new FoundationRegistry(createSupabaseFoundationStore(supabase));
    await _foundationRegistry.refresh();
    return _foundationRegistry;
  } catch (err) {
    log.warn("Foundation registry failed to load — using hardcoded fallback", { error: String(err) });
    return null;
  }
}

import { getForestContext } from "./elasticsearch/context.ts";
import { acknowledgeChannel } from "./delivery.ts";
import { parseMentions, extractMentionedAgents, hasBroadcastMention, storeMentions } from "./mention-parser.ts";
import { updateAgentPresence } from "./api/channels.ts";
import {
  routeAndDispatch,
  syncResponse,
  type RouteResult,
  type DispatchResult,
} from "./agent-router.ts";
import { getSkillSnapshot, matchInstantCommand } from "./skills/index.ts";
import {
  getSpecialistAck,
  estimateTokens,
  trimSearchContext,
} from "./relay-utils.ts";
import {
  getAgentStructuredContext, getAgentMemoryContext, getMaxMemoriesForModel,
  getLiveForestContext,
} from "./context-sources.ts";
import { getAgentMemorySummary } from "./agent-memory-store.ts";
import {
  executeOrchestrated,
  PipelineStepError,
  type PipelineStep,
} from "./orchestrator.ts";
import {
  isPlaneConfigured,
  fetchWorkItemDetails,
  createPlaneIssue,
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
import { isContextRefresh, detectMode } from "./context-mode.ts";
import { freshnessTracker, autoRefreshStaleSources } from "./context-freshness.ts";
import { refreshSource } from "./context-sources.ts";
import { checkGroundTruthConflicts, buildCrossChannelSection } from "./source-hierarchy.ts";
import { logVerificationTrail } from "./data-quality.ts";
import { getCreatureProfile } from "./creature-profile.ts";
import { withTrace } from "./trace.ts";
import { createJob, updateJob, appendJobEvent, verifyJobWork, estimateJobCost } from "./jobs-ledger.ts";
import { checkContextPressure, shouldNotify, getCompactionNotice, checkpointSessionToForest } from "./api/session-compaction.ts";
import { resilientTask } from "./resilient-task.ts";
import { primeWorkingMemoryCache } from "./working-memory.ts";
import { trackDispatchStart, trackDispatchComplete, trackDispatchFailure } from "./dispatch-commitment-tracker.ts";
import { setPendingCommitmentsContext } from "./pending-commitments-prompt.ts";
import { detectAndLogCommitments } from "./conversational-commitment-detector.ts";
import {
  isFallbackActive,
  isOutageError,
  recordAnthropicSuccess,
  recordAnthropicFailure,
  consumeFallbackJustActivated,
  callOpenAiFallback,
} from "./llm-provider.ts";
import {
  _resolveContextMode as resolveContextMode,
  _buildShouldFetch as buildShouldFetch,
  _gatherContextSources as gatherContextSources,
} from "./ellie-chat-pipeline.ts";
import {
  extractCommandBarScope,
  extractWorkItemId,
  classifyRoute,
  COMMAND_BAR_CHANNEL_ID,
} from "./ellie-chat-utils.ts";

export async function handleEllieChatMessage(
  ws: WebSocket,
  text: string,
  phoneMode: boolean = false,
  image?: { data: string; mime_type: string; name: string },
  channelId?: string,
  clientId?: string,
  mode?: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  // ELLIE-461: Top-level error boundary — any uncaught error gets a user-facing message
  try {
    return await withTrace(async () => _handleEllieChatMessage(ws, text, phoneMode, image, channelId, clientId, mode, abortSignal));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Don't send error to user for aborted dispatches — they closed the connection
    if (msg.includes("aborted") || msg.includes("Aborted")) return;
    logger.error("[ellie-chat] Unhandled dispatch error", { error: msg });
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "response",
        text: "Something went wrong on my end. Please try again.",
        agent: "system",
        ts: Date.now(),
      }));
    }
  }
}

async function _handleEllieChatMessage(
  ws: WebSocket,
  text: string,
  phoneMode: boolean,
  image?: { data: string; mime_type: string; name: string },
  channelId?: string,
  clientId?: string,
  mode?: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  const { bot, anthropic, supabase } = getRelayDeps();
  logger.info("User message received", { phoneMode, hasImage: !!image, mode, channelId: channelId?.substring(0, 8) });
  acknowledgeChannel("ellie-chat");

  // ELLIE-1136: Flag user activity so overnight scheduler stops
  const { flagUserActivity, isOvernightRunning } = await import("./overnight/scheduler.ts");
  if (isOvernightRunning()) flagUserActivity();

  const ecUser = wsAppUserMap.get(ws);
  const ecUserId = ecUser?.id || ecUser?.anonymous_id || undefined;

  await saveMessage("user", text, image ? { image_name: image.name, image_mime: image.mime_type } : {}, "ellie-chat", ecUserId, clientId, "user");
  broadcastExtension({ type: "message_in", channel: "ellie-chat", preview: text.substring(0, 200) });

  // ELLIE-426: Resolve archetype profile from mode
  let channelProfile: import("./api/mode-profile.ts").ChannelContextProfile | null = null;
  if (mode) {
    try {
      const { resolveArchetypeProfile } = await import("./api/mode-profile.ts");
      channelProfile = await resolveArchetypeProfile(mode);
      logger.info(`Mode profile: mode=${mode} contextMode=${channelProfile.contextMode} budget=${channelProfile.tokenBudget}`);
    } catch (err) {
      logger.warn("Mode profile resolution failed, falling back to mode detection", err);
    }
  }

  // ELLIE-400: Extract scope context from command bar messages
  let commandBarContext: string | undefined;
  {
    const { scopePath, strippedText } = extractCommandBarScope(text, channelId);
    if (scopePath) {
      commandBarContext = `FOREST EDITOR CONTEXT:\nYou are operating in the inline Forest Editor command bar on the Knowledge Tree page.\nThe user is viewing scope: ${scopePath}\nWhen writing memories, use scope_path: "${scopePath}"\nWhen browsing or searching, start from this scope.\nKeep responses concise — this is an inline editor, not a full chat.`;
      text = strippedText;
    }
  }

  // Correction detection + calendar linking (ELLIE-250)
  if (supabase) {
    const convId = await getOrCreateConversation(supabase, "ellie-chat", "general", channelId);
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
            resilientTask("detectAndCaptureCorrection", "best-effort", () =>
              detectAndCaptureCorrection(text, data.content, anthropic, "ellie-chat", convId));
          }
        })
        .catch(() => {});

      // Calendar-conversation linking — detect event mentions
      resilientTask("detectAndLinkCalendarEvents", "best-effort", () =>
        detectAndLinkCalendarEvents(text, supabase, convId));
    }
  }

  // Write image to temp file if present (same pattern as Telegram photo handler)
  let imagePath: string | null = null;
  if (image?.data) {
    try {
      const ext = image.mime_type === "image/png" ? ".png"
        : image.mime_type === "image/gif" ? ".gif"
        : image.mime_type === "image/webp" ? ".webp"
        : ".jpg";
      imagePath = join(UPLOADS_DIR, `ellie-chat_${Date.now()}${ext}`);
      await writeFile(imagePath, Buffer.from(image.data, "base64"));
      logger.info(`Image saved: ${imagePath}`);
    } catch (err) {
      logger.error("Failed to save image", err);
      imagePath = null;
    }
  }

  // Send typing indicator
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "typing", ts: Date.now(), channelId, agent: "general" }));
  }

  // ── Centralized Command Registry (ELLIE-1162) ──────────────
  // All slash commands dispatched through the registry.
  // /ticket is still handled below (needs Claude + async context).
  if (text.trim().startsWith("/") && !text.startsWith("/ticket")) {
    const { dispatchCommand } = await import("./command-registry.ts");
    const cmdResult = await dispatchCommand(text, {
      text,
      channel: "ellie-chat",
      userId: ecUserId || "dashboard",
      sendResponse: async (msg) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "response", text: msg, agent: "system", ts: Date.now(), channelId }));
        }
      },
    });
    if (cmdResult.handled) {
      if (cmdResult.response && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "response", text: cmdResult.response, agent: "system", ts: Date.now(), channelId }));
      }
      // /plan needs extra side effects
      if (text.match(/^\/plan\s/i)) {
        resetTelegramIdleTimer();
        resetGchatIdleTimer();
        resetEllieChatIdleTimer();
        broadcastExtension({ type: "planning_mode", active: getPlanningMode() });
      }
      return;
    }
    // Not handled by registry — fall through to instant commands / coordinator
  }

  // /ticket — create Plane ticket from context (needs Claude, stays here)
  if (text.startsWith("/ticket")) {
    const ticketText = text.slice(7).trim();
    (async () => {
      try {
        let contextMessages: string[];
        if (ticketText) {
          contextMessages = [ticketText];
        } else if (supabase) {
          const { data: recent } = await supabase.from("messages")
            .select("role, content").in("channel", ["ellie-chat", "la-comms"])
            .order("created_at", { ascending: false }).limit(5);
          contextMessages = (recent || []).reverse().map((m: { role: string; content: string }) => `[${m.role}]: ${m.content}`);
        } else {
          contextMessages = ["No context available"];
        }

        const context = contextMessages.join("\n---\n");
        const prompt = `Generate a Plane project ticket from this context. Return ONLY valid JSON with no markdown formatting:\n{"title": "concise title under 80 chars", "description": "detailed description with requirements as bullet points", "priority": "medium"}\n\nPriority must be one of: urgent, high, medium, low, none.\n\nContext:\n${context}`;

        logger.info(`/ticket command — generating from ${ticketText ? "user text" : "last 5 messages"}...`);
        const raw = await callClaude(prompt);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("Could not parse ticket JSON");
        const ticket = JSON.parse(jsonMatch[0]);

        const result = await createPlaneIssue("ELLIE", ticket.title, ticket.description, ticket.priority);
        if (!result) throw new Error("Plane API failed");

        const msg = `Created ${result.identifier}: ${ticket.title}`;
        logger.info(msg);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "response", text: msg, agent: "system", ts: Date.now() }));
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error("/ticket error", { detail: errMsg });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "response", text: `Failed to create ticket: ${errMsg.slice(0, 200) || "unknown error"}`, agent: "system", ts: Date.now() }));
        }
      }
    })();
    return;
  }

  // Instant skill commands — static content, no Claude call (sub-100ms)
  try {
    const instant = await matchInstantCommand(text);
    if (instant) {
      logger.info(`Instant command: /${instant.skillName} ${instant.subcommand}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "response", text: instant.response, agent: "system", ts: Date.now(), channelId }));
      }
      return;
    }
  } catch (err) {
    logger.warn("Instant command match failed", err);
  }

  // ELLIE:: user-typed commands — bypass classifier, execute directly
  const { cleanedText: ellieChatPlaybookClean, commands: ellieChatPlaybookCmds } = extractPlaybookCommands(text);
  if (ellieChatPlaybookCmds.length > 0) {
    logger.info(`ELLIE:: commands in user message: ${ellieChatPlaybookCmds.map(c => c.type).join(", ")}`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "response", text: `Processing ${ellieChatPlaybookCmds.length} playbook command(s)...`, agent: "system", ts: Date.now() }));
    }
    const pbCtx: PlaybookContext = { bot, supabase, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, channel: "ellie-chat", callClaudeFn: callClaude, buildPromptFn: buildPrompt };
    executePlaybookCommands(ellieChatPlaybookCmds, pbCtx)
      .then(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "response", text: `Playbook command(s) completed.`, agent: "system", ts: Date.now() }));
        }
      })
      .catch(err => {
        logger.error("Playbook execution failed", err);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "response", text: `Playbook error: ${err?.message?.slice(0, 200) || "unknown"}`, agent: "system", ts: Date.now() }));
        }
      });
    return;
  }

  // ── Verification code detection (ELLIE-176) ──
  // If app user is in email_sent state and message looks like a 6-digit code, auto-verify
  const appUser = wsAppUserMap.get(ws);
  if (appUser && appUser.onboarding_state === 'email_sent' && /^\d{6}$/.test(text.trim())) {
    await enqueueEllieChat(async () => {
      try {
        const { sql: forestSql } = await import("../../ellie-forest/src/index");
        const code = text.trim();

        // Find matching code for this user's email
        const [codeRow] = await forestSql<{ id: string; attempts: number }[]>`
          SELECT id, attempts FROM verification_codes
          WHERE email = ${appUser.email} AND code = ${code}
            AND used = FALSE AND expires_at > NOW()
          ORDER BY created_at DESC LIMIT 1
        `;

        if (codeRow && codeRow.attempts < 5) {
          // Mark code as used
          await forestSql`UPDATE verification_codes SET used = TRUE WHERE id = ${codeRow.id}`;

          // Upgrade user
          const { getUserByToken, generateToken } = await import("./api/app-auth.ts");
          const { createPerson } = await import("../../ellie-forest/src/people");
          const token = generateToken();

          // Create person record if needed
          let personId: string | null = null;
          if (appUser.name) {
            try {
              const person = await createPerson({ name: appUser.name, relationship_type: 'app-user', contact_methods: { email: appUser.email } });
              personId = person.id;
            } catch { /* person may already exist */ }
          }

          await forestSql`
            UPDATE app_users SET
              session_token = ${token},
              onboarding_state = 'verified',
              verified_at = NOW(),
              person_id = COALESCE(person_id, ${personId}),
              last_seen_at = NOW()
            WHERE email = ${appUser.email}
          `;

          // Update wsAppUserMap
          appUser.onboarding_state = 'verified';
          wsAppUserMap.set(ws, appUser);

          // Notify client
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "session_upgraded", ts: Date.now(), token, user: { id: appUser.id, name: appUser.name, onboarding_state: 'verified' } }));
            ws.send(JSON.stringify({ type: "response", text: `Perfect, ${appUser.name || 'friend'}! Your account is verified. I'll remember our conversations from now on.`, agent: "general", ts: Date.now() }));
          }
          const verifyHistKey = ecUserId || 'anonymous';
          if (!ellieChatPhoneHistories.has(verifyHistKey)) ellieChatPhoneHistories.set(verifyHistKey, []);
          touchPhoneHistory(verifyHistKey);
          const verifyHist = ellieChatPhoneHistories.get(verifyHistKey)!;
          verifyHist.push({ role: "user", content: text });
          verifyHist.push({ role: "assistant", content: `Perfect, ${appUser.name || 'friend'}! Your account is verified. I'll remember our conversations from now on.` });
          logger.info("Code verified — session upgraded");
        } else {
          // Wrong code — increment attempts, fall through to Claude
          if (appUser.email) {
            await forestSql`
              UPDATE verification_codes SET attempts = attempts + 1
              WHERE email = ${appUser.email} AND used = FALSE AND expires_at > NOW()
            `;
          }
          // Let Claude handle it naturally — the onboarding context will remind about the code
        }
      } catch (err) {
        logger.error("Code detection error", err);
      }
    }, "code-verify");
    // If code was valid, we already sent the response — check if state changed
    const updatedUser = wsAppUserMap.get(ws);
    if (updatedUser && updatedUser.onboarding_state === 'verified') return;
  }

  if (phoneMode) {
    // ── Phone mode fast path: 6-turn context, Haiku, brevity prompt, no agent routing ──
    await enqueueEllieChat(async () => {
      markProcessing(ecUserId || "anonymous", text);
      // Per-user phone history (ELLIE-197)
      const phoneHistKey = ecUserId || 'anonymous';
      if (!ellieChatPhoneHistories.has(phoneHistKey)) ellieChatPhoneHistories.set(phoneHistKey, []);
      touchPhoneHistory(phoneHistKey);
      const phoneHistory = ellieChatPhoneHistories.get(phoneHistKey)!;
      phoneHistory.push({ role: "user", content: text });

      const conversationContext = phoneHistory
        .slice(-6)
        .map(m => `${m.role}: ${m.content}`)
        .join("\n");

      // Lightweight context — skip structured context, recent messages, agent routing
      const lightweightResults = await Promise.allSettled([
        getContextDocket(),
        getRelevantContext(supabase, text, "ellie-chat", getActiveAgent("ellie-chat")),
        searchElastic(text, { limit: 3, recencyBoost: true, channel: "ellie-chat", sourceAgent: getActiveAgent("ellie-chat") }),
      ]);
      const contextDocket = lightweightResults[0].status === "fulfilled" ? lightweightResults[0].value : "";
      const relevantContext = lightweightResults[1].status === "fulfilled" ? lightweightResults[1].value : "";
      const elasticContext = lightweightResults[2].status === "fulfilled" ? lightweightResults[2].value : "";
      lightweightResults.forEach((r, i) => {
        if (r.status === "rejected") {
          const sources = ["contextDocket", "relevantContext", "elasticContext"];
          logger.warn(`[ellie-chat-voice] Context source ${sources[i]} failed — using fallback`, { error: r.reason });
        }
      });

      const systemParts = [
        "You are Ellie, a personal AI assistant. You are in a VOICE CONVERSATION via the phone app.",
        "Keep responses SHORT and natural for speech — 1-3 sentences max.",
        "No markdown, no bullet points, no formatting. Just spoken words.",
        "Be warm and conversational, like talking to a friend.",
      ];

      // Onboarding context injection (ELLIE-176)
      const wsUser = wsAppUserMap.get(ws);
      if (wsUser) {
        if (wsUser.name) systemParts.push(`You are speaking with ${wsUser.name}.`);
        switch (wsUser.onboarding_state) {
          case 'anonymous':
            systemParts.push("\nThis is a new user you haven't met before. After 2-3 natural exchanges, ask what you should call them. Don't rush it — let the conversation flow first.");
            break;
          case 'named':
            systemParts.push(`\n${wsUser.name} has told you their name but hasn't verified their email yet. After a few more exchanges, naturally suggest that you could remember conversations across sessions if they share their email. Frame it as a benefit, not a requirement.`);
            break;
          case 'email_sent':
            systemParts.push(`\nYou sent a verification code to ${wsUser.email}. Gently remind them to check their email and type the 6-digit code here. Don't be pushy — just mention it if the conversation allows.`);
            break;
          case 'verified':
            systemParts.push(`\n${wsUser.name || 'This user'} just verified their account! You can now remember conversations. Over the next few exchanges, learn their timezone and interests naturally. Don't interrogate — weave it into conversation.`);
            systemParts.push(`\nWhen you learn their timezone, include ELLIE::SET_TIMEZONE <timezone> at the END of your response (e.g., ELLIE::SET_TIMEZONE America/Chicago). When you feel onboarding is complete, add ELLIE::ONBOARDING_COMPLETE at the end.`);
            break;
          default:
            if (wsUser.name) systemParts.push(`You are speaking with ${wsUser.name}.`);
        }
        if (wsUser.onboarding_state === 'anonymous' || wsUser.onboarding_state === 'named') {
          systemParts.push(`\nWhen the user tells you their name, include ELLIE::SET_NAME <name> at the END of your response.`);
          systemParts.push(`When the user shares their email, include ELLIE::REQUEST_EMAIL <email> at the END of your response.`);
          systemParts.push(`These ELLIE:: commands are invisible to the user — they trigger backend actions.`);
        }
      } else {
        if (USER_NAME) systemParts.push(`You are speaking with ${USER_NAME}.`);
      }

      // Playbook commands — available to primary user and onboarded app users
      const phoneUserOnboarded = !wsUser || wsUser.onboarding_state === 'onboarded' || wsUser.onboarding_state === 'verified';
      if (phoneUserOnboarded) {
        systemParts.push(
          "\nYou can take actions by adding commands at the END of your response (invisible to user):",
          '- Create a ticket: ELLIE:: create ticket "Title" "Description"',
          "- Dispatch work: ELLIE:: send ELLIE-XXX to dev",
          '- Close a ticket: ELLIE:: close ELLIE-XXX "Summary"',
          "Use these when the user asks you to create tickets, dispatch work, or close items.",
        );
      }

      if (contextDocket) systemParts.push(`\n${contextDocket}`);
      const ellieChatSearchBlock = trimSearchContext([relevantContext || '', elasticContext || '']);
      if (ellieChatSearchBlock) systemParts.push(`\n${ellieChatSearchBlock}`);

      const systemPrompt = systemParts.join("\n");
      const userName = wsUser?.name || USER_NAME || "the user";
      const userPrompt = conversationContext
        ? `Conversation so far:\n${conversationContext}\n\n${userName} just said: ${text}`
        : `${userName} said: ${text}`;

      const startTime = Date.now();
      const rawResponse = await callClaudeVoice(systemPrompt, userPrompt);
      const durationMs = Date.now() - startTime;

      // Process playbook commands (create ticket, send, close) — before onboarding commands
      let responseText = rawResponse.trim();
      const { cleanedText: phonePbClean, commands: phonePbCmds } = extractPlaybookCommands(responseText);
      if (phonePbCmds.length > 0) {
        responseText = phonePbClean;
        const pbCtx: PlaybookContext = { bot, supabase, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, channel: "ellie-chat", callClaudeFn: callClaude, buildPromptFn: buildPrompt };
        executePlaybookCommands(phonePbCmds, pbCtx).catch(err => logger.error("Phone playbook execution failed", err));
        logger.info(`Phone mode playbook: ${phonePbCmds.map(c => c.type).join(", ")}`);
      }

      // Process ELLIE:: onboarding commands (ELLIE-176)
      if (wsUser) {
        const ellieCommands = responseText.match(/ELLIE::\S+.*$/gm) || [];
        for (const cmd of ellieCommands) {
          responseText = responseText.replace(cmd, '').trim();
          try {
            const { sql: forestSql } = await import("../../ellie-forest/src/index");

            if (cmd.startsWith('ELLIE::SET_NAME ')) {
              const name = cmd.replace('ELLIE::SET_NAME ', '').trim();
              if (name) {
                wsUser.name = name;
                // Create or update app_user record
                if (wsUser.anonymous_id && !wsUser.id) {
                  const [existing] = await forestSql<{ id: string }[]>`SELECT id FROM app_users WHERE anonymous_id = ${wsUser.anonymous_id}`;
                  if (existing) {
                    await forestSql`UPDATE app_users SET name = ${name}, onboarding_state = 'named' WHERE id = ${existing.id}`;
                    wsUser.id = existing.id;
                  } else {
                    const [newUser] = await forestSql<{ id: string }[]>`
                      INSERT INTO app_users (name, anonymous_id, onboarding_state) VALUES (${name}, ${wsUser.anonymous_id}, 'named') RETURNING id
                    `;
                    wsUser.id = newUser.id;
                  }
                } else if (wsUser.id) {
                  await forestSql`UPDATE app_users SET name = ${name}, onboarding_state = 'named' WHERE id = ${wsUser.id}`;
                }
                wsUser.onboarding_state = 'named';
                wsAppUserMap.set(ws, wsUser);
                logger.info("SET_NAME completed");
              }
            }

            if (cmd.startsWith('ELLIE::REQUEST_EMAIL ')) {
              const email = cmd.replace('ELLIE::REQUEST_EMAIL ', '').trim().toLowerCase();
              if (email && email.includes('@')) {
                wsUser.email = email;
                // Update user record with email
                if (wsUser.id) {
                  await forestSql`UPDATE app_users SET email = ${email}, onboarding_state = 'email_sent' WHERE id = ${wsUser.id}`;
                }
                // Generate and send verification code
                const { sendVerificationCode } = await import("./email.ts");
                const code = String(Math.floor(100000 + Math.random() * 900000));
                const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
                await forestSql`INSERT INTO verification_codes (email, code, expires_at) VALUES (${email}, ${code}, ${expiresAt})`;
                await sendVerificationCode(email, code);
                wsUser.onboarding_state = 'email_sent';
                wsAppUserMap.set(ws, wsUser);
                logger.info("REQUEST_EMAIL: verification code sent");
              }
            }

            if (cmd.startsWith('ELLIE::SET_TIMEZONE ')) {
              const tz = cmd.replace('ELLIE::SET_TIMEZONE ', '').trim();
              if (tz && wsUser.id) {
                await forestSql`UPDATE app_users SET timezone = ${tz} WHERE id = ${wsUser.id}`;
                logger.info(`SET_TIMEZONE: ${tz}`);
              }
            }

            if (cmd.startsWith('ELLIE::ONBOARDING_COMPLETE')) {
              if (wsUser.id) {
                await forestSql`UPDATE app_users SET onboarding_state = 'onboarded' WHERE id = ${wsUser.id}`;
                wsUser.onboarding_state = 'onboarded';
                wsAppUserMap.set(ws, wsUser);
                logger.info("ONBOARDING_COMPLETE");
              }
            }
          } catch (err) {
            logger.error("ELLIE:: command error", { cmd }, err);
          }
        }
      }

      const cleanedText = responseText;
      phoneHistory.push({ role: "assistant", content: cleanedText });

      // Cap per-user history at 20 entries to prevent memory growth
      if (phoneHistory.length > 20) phoneHistory.splice(0, phoneHistory.length - 20);

      // Post-message psy assessment (ELLIE-330)
      runPostMessageAssessment(text, cleanedText, anthropic).catch(err => logger.error("Post-message assessment failed", err));

      const phoneMemoryId = await saveMessage("assistant", cleanedText, {}, "ellie-chat", ecUserId);
      broadcastExtension({
        type: "message_out", channel: "ellie-chat",
        agent: "general",
        preview: cleanedText.substring(0, 200),
      });

      deliverResponse(ws, {
        type: "response",
        text: cleanedText,
        agent: "general",
        memoryId: phoneMemoryId,
        ts: Date.now(),
        duration_ms: durationMs,
        channelId,
      });
      clearProcessing(ecUserId || "anonymous");

      resetEllieChatIdleTimer();
    }, text.substring(0, 100));
    return;
  }

  // ── Normal text mode: full agent routing + context gathering (mirrors Google Chat) ──
  // ELLIE-482: Accept queue-level abort signal so queue timeout kills the subprocess
  await enqueueEllieChat(async (queueSignal) => {
    markProcessing(ecUserId || "anonymous", text);
    // ELLIE-391: Context refresh — bust all caches so this message gets fully fresh data
    if (isContextRefresh(text)) {
      freshnessTracker.clear();
      clearContextCache();
      logger.info("Context refresh triggered — reloading all sources");
    }

    const ellieChatWorkItem = extractWorkItemId(text);

    // ELLIE-849: Parse @mentions before routing
    const mentions = parseMentions(text);
    const mentionedAgents = extractMentionedAgents(text);
    const broadcast = hasBroadcastMention(text);
    if (mentions.length > 0) {
      logger.info("Mentions detected", { mentions: mentions.map(m => m.raw), broadcast });
      // Store mentions in DB (fire and forget)
      storeMentions(supabase, clientId || "unknown", channelId || null, mentions).catch(() => {});
    }

    // ELLIE-852: @here/@channel broadcast — notify all online/all channel agents
    if (broadcast.here || broadcast.channel) {
      const presenceAgents = broadcast.here
        ? await supabase.from("agent_presence").select("agent_name").neq("status", "offline").then(r => r.data?.map(p => p.agent_name) || [])
        : await supabase.from("channel_members").select("member_id").eq("channel_id", channelId || "a0000000-0000-0000-0000-000000000001").eq("member_type", "agent").then(r => r.data?.map(m => m.member_id) || []);
      logger.info(`Broadcast ${broadcast.here ? "@here" : "@channel"} → ${presenceAgents.length} agents`, { agents: presenceAgents });
      // Broadcast notification to WS clients
      broadcastToEllieChatClients({
        type: "mention_notification",
        mention_type: broadcast.here ? "here" : "channel",
        agents: presenceAgents,
        channel_id: channelId,
        ts: Date.now(),
      });
    }

    // ELLIE-381: Pre-routing mode check — skill-only → road-runner override
    const preRouteDetection = detectMode(text);
    const skillOnlyOverride = preRouteDetection?.mode === "skill-only" ? "road-runner" : undefined;
    if (skillOnlyOverride) {
      logger.info("Skill-only mode detected — routing to road-runner");
    }

    // ELLIE-849: If a specific agent is @mentioned, override routing to that agent
    const mentionOverride = mentionedAgents.length === 1 ? mentionedAgents[0] : skillOnlyOverride;

    const agentResult = await routeAndDispatch(supabase, text, "ellie-chat", "dashboard", ellieChatWorkItem, mentionOverride || skillOnlyOverride);
    let effectiveText = agentResult?.route.strippedMessage || text;
    // Prepend image file reference so Claude Code CLI can see the image
    if (imagePath) {
      effectiveText = `[Image: ${imagePath}]\n\n${effectiveText || "Analyze this image."}`;
    }
    // ELLIE-1133: Hoist so coordinator block can access it
    let dispatchConfirmMsgId: number | undefined;

    if (agentResult) {
      setActiveAgent("ellie-chat", agentResult.dispatch.agent.name);
      // ELLIE-846: Update agent presence to busy + broadcast
      updateAgentPresence(supabase, agentResult.dispatch.agent.name, "busy", channelId, `Processing message`).catch(() => {});
      broadcastToEllieChatClients({
        type: "presence_update",
        agent_name: agentResult.dispatch.agent.name,
        status: "busy",
        channel_id: channelId,
        ts: Date.now(),
      });
      // ELLIE-383: Include contextMode from pre-route detection in route broadcast
      broadcastExtension({
        type: "route", channel: "ellie-chat",
        agent: agentResult.dispatch.agent.name,
        mode: agentResult.route.execution_mode,
        contextMode: preRouteDetection?.mode || undefined,
      });

      // ELLIE-853: Update typing indicator with actual routed agent name
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "typing", ts: Date.now(), channelId, agent: agentResult.dispatch.agent.name }));
      }

      // Dispatch notification (ELLIE-80 pattern from Google Chat)
      if (agentResult.dispatch.agent.name !== "general" && agentResult.dispatch.is_new) {
        notify(getNotifyCtx(), {
          event: "dispatch_confirm",
          workItemId: agentResult.dispatch.agent.name,
          telegramMessage: `🤖 ${agentResult.dispatch.agent.name} agent`,
          gchatMessage: `🤖 ${agentResult.dispatch.agent.name} agent dispatched`,
        }).then(r => { dispatchConfirmMsgId = r.telegramMessageId; })
          .catch((err) => logger.error("dispatch_confirm notification failed", { detail: err.message }));
      }
    } else {
      // Routing failed — notify user and fall back to general agent
      logger.error("routeAndDispatch returned null (ellie-chat), falling back to general agent");
      setActiveAgent("ellie-chat", "general");
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "error",
          message: "⚠️ Routing failed — using general agent",
          ts: Date.now(),
          channelId,
        }));
      }
    }

    // ── ASYNC SPECIALIST PATH: ack immediately, run in background ──
    const ecRouteAgent = agentResult?.dispatch?.agent?.name || "general";
    const { isSpecialist, isMultiStep } = classifyRoute(
      ecRouteAgent,
      agentResult?.route.execution_mode,
      agentResult?.route.skills?.length ?? 0,
    );

    if (isSpecialist && !isMultiStep && agentResult && process.env.COORDINATOR_MODE !== "true") {
      const ack = getSpecialistAck(ecRouteAgent);
      const ackMemoryId = await saveMessage("assistant", ack, { agent: "general" }, "ellie-chat", ecUserId);
      deliverResponse(ws, { type: "response", text: ack, agent: "general", memoryId: ackMemoryId, ts: Date.now() });
      broadcastExtension({ type: "message_out", channel: "ellie-chat", agent: "general", preview: ack });

      // Fire-and-forget: specialist runs outside the queue
      // ELLIE-479: WS-disconnect abort not used — specialist survives WS close since it's already acked
      // ELLIE-482: queue-timeout signal passed so specialist can be aborted on queue timeout
      runSpecialistAsync(ws, supabase, effectiveText, text, agentResult, imagePath, ellieChatWorkItem, channelId, channelProfile, queueSignal).catch(err => {
        logger.error("Specialist async error", err);
      });

      resetEllieChatIdleTimer();
      return; // queue task done — queue is free for next message
    }

    const ellieChatActiveAgent = getActiveAgent("ellie-chat");
    const ecConvoId = await getOrCreateConversation(supabase!, "ellie-chat", "general", channelId) || undefined;

    // ── ELLIE-325/334: Mode detection — channel profile overrides regex detection ──
    const ecConvoKey = ecConvoId || "ellie-chat-default";
    const { contextMode, modeChanged } = resolveContextMode(ecConvoKey, effectiveText, channelProfile);
    if (channelProfile) {
      logger.info(`Context mode resolved: mode=${contextMode} source=channel-profile`);
    } else if (modeChanged) {
      logger.info(`Context mode resolved: mode=${contextMode} source=detection`);
    }

    // Mode-aware fetch gating — skip sources that would be suppressed (priority >= 7)
    // ELLIE-367: creature priorities take precedence over mode priorities
    const shouldFetch = buildShouldFetch(contextMode, ellieChatActiveAgent);
    const ecCreatureProfile = getCreatureProfile(ellieChatActiveAgent); // needed for skill snapshot

    const { convoContext: ecConvoContext, contextDocket, relevantContext, elasticContext, structuredContext, forestContext, agentMemory, queueContext: ecQueueContext, liveForest } = await gatherContextSources(
      supabase, ecConvoId, effectiveText, ellieChatActiveAgent, agentResult?.dispatch ?? null, ellieChatWorkItem, shouldFetch,
    );
    const recentMessages = ecConvoContext.text;
    if (agentResult?.dispatch.is_new && ecQueueContext) {
      resilientTask("acknowledgeQueueItems", "critical", () => acknowledgeQueueItems(ellieChatActiveAgent));
    }

    // ELLIE-327: Track section-level freshness for non-registry sources
    if (recentMessages) freshnessTracker.recordFetch("recent-messages", 0);
    if (ecQueueContext) freshnessTracker.recordFetch("queue", 0);
    if (contextDocket) freshnessTracker.recordFetch("context-docket", 0);
    if (relevantContext || elasticContext || forestContext) freshnessTracker.recordFetch("search", 0);

    // ELLIE-327: Log mode config + freshness status
    freshnessTracker.logModeConfig(contextMode);
    freshnessTracker.logAllFreshness(contextMode);

    // ELLIE-327: Auto-refresh stale critical sources (only for non-suppressed sections)
    const refreshSources: Record<string, () => Promise<string>> = {
      ...(shouldFetch("structured-context") && { "structured-context": () => getAgentStructuredContext(supabase, ellieChatActiveAgent) }),
      ...(shouldFetch("context-docket") && { "context-docket": () => { clearContextCache(); return getContextDocket(); } }),
      "agent-memory": async () => {
        const mem = await getAgentMemoryContext(ellieChatActiveAgent, ellieChatWorkItem, getMaxMemoriesForModel(agentResult?.dispatch.agent.model));
        return mem.memoryContext;
      },
      "forest-awareness": async () => {
        const lf = await getLiveForestContext(effectiveText);
        return lf.awareness;
      },
    };
    const { refreshed: ecRefreshed, results: ecRefreshResults } = await autoRefreshStaleSources(
      contextMode,
      refreshSources,
    );

    // Detect work item mentions (ELLIE-5, EVE-3, etc.) — matches Telegram text handler
    let workItemContext = "";
    const workItemMatch = effectiveText.match(/\b([A-Z]+-\d+)\b/);
    const isEllieChatWorkIntent = agentResult?.route.skill_name === "code_changes" ||
      agentResult?.route.skill_name === "code_review" ||
      agentResult?.route.skill_name === "debugging";
    if (workItemMatch && isPlaneConfigured()) {
      const wiStart = Date.now();
      const details = await fetchWorkItemDetails(workItemMatch[1]);
      const wiLatency = Date.now() - wiStart;
      if (details) {
        const label = isEllieChatWorkIntent ? "ACTIVE WORK ITEM" : "REFERENCED WORK ITEM";
        workItemContext = `\n${label}: ${workItemMatch[1]}\n` +
          `Title: ${details.name}\n` +
          `Priority: ${details.priority}\n` +
          `Description: ${details.description}\n`;
        freshnessTracker.recordFetch("work-item", wiLatency);

        // ELLIE-328: Log verification trail for work item health check
        logVerificationTrail({
          channel: "ellie-chat",
          agent: ellieChatActiveAgent || "general",
          conversation_id: ecConvoId || undefined,
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

    // Auto-load work item from channel's work_item_id (deep-work ephemeral channels)
    if (!workItemContext && channelProfile?.workItemId && isPlaneConfigured()) {
      const wiStart = Date.now();
      const details = await fetchWorkItemDetails(channelProfile.workItemId);
      const wiLatency = Date.now() - wiStart;
      if (details) {
        workItemContext = `\nACTIVE WORK ITEM: ${channelProfile.workItemId}\n` +
          `Title: ${details.name}\n` +
          `Priority: ${details.priority}\n` +
          `Description: ${details.description}\n`;
        freshnessTracker.recordFetch("work-item", wiLatency);
      }
    }

    // ── Multi-step orchestration (pipeline, fan-out, critic-loop) ──
    if (agentResult?.route.execution_mode !== "single" && agentResult?.route.skills?.length) {
      const execMode = agentResult.route.execution_mode;
      const steps: PipelineStep[] = agentResult.route.skills.map((s) => ({
        agent_name: s.agent,
        skill_name: s.skill !== "none" ? s.skill : undefined,
        instruction: s.instruction,
      }));

      const agentNames = [...new Set(steps.map((s) => s.agent_name))].join(" → ");
      const modeLabels: Record<string, string> = { pipeline: "Pipeline", "fan-out": "Fan-out", "critic-loop": "Critic loop" };

      // Notify client that multi-step is starting
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "response",
          text: `Working on it... (${modeLabels[execMode] || execMode}: ${agentNames}, ${steps.length} steps)`,
          agent: agentResult.dispatch.agent.name,
          ts: Date.now(),
        }));
      }
      broadcastExtension({ type: "pipeline_start", channel: "ellie-chat", mode: execMode, steps: steps.length });

      try {
        const result = await executeOrchestrated(execMode, steps, effectiveText, {
          supabase,
          channel: "ellie-chat",
          userId: "dashboard",
          anthropicClient: anthropic,
          contextDocket, relevantContext, elasticContext,
          structuredContext, recentMessages, workItemContext, forestContext,
          buildPromptFn: buildPrompt,
          callClaudeFn: callClaude,
        });

        const orcAgent = result.finalDispatch?.agent?.name || agentResult.dispatch.agent.name || "general";
        const pipelineResponse = await processMemoryIntents(supabase, result.finalResponse, orcAgent, "shared", agentMemory.sessionIds);
        // ELLIE-649 Tier 2: Process response tags for conversation_facts
        const tier2Pipeline = await import("./response-tag-processor.ts").then(m => m.processResponseTags(supabase, pipelineResponse, "ellie-chat"));
        // ELLIE-592: Detect conversational commitments in orchestrated response
        detectAndLogCommitments(tier2Pipeline, session.sessionId, 0);
        const { cleanedText: ellieChatOrcPlaybookClean, commands: ellieChatOrcPlaybookCmds } = extractPlaybookCommands(tier2Pipeline);
        // ELLIE-389: Save first to get memoryId, then send with it
        const { cleanedText: orcPreClean } = extractApprovalTags(ellieChatOrcPlaybookClean);
        const orcMemoryId = await saveMessage("assistant", orcPreClean, { agent: orcAgent }, "ellie-chat", ecUserId);
        const { cleanedText, hadConfirmations } = sendWithApprovalsEllieChat(ws, ellieChatOrcPlaybookClean, session.sessionId, orcAgent, orcMemoryId);

        broadcastExtension({
          type: "message_out", channel: "ellie-chat", agent: orcAgent,
          preview: cleanedText.substring(0, 200),
        });
        broadcastExtension({
          type: "pipeline_complete", channel: "ellie-chat",
          mode: execMode, steps: result.stepResults.length,
          duration_ms: result.artifacts.total_duration_ms,
          cost_usd: result.artifacts.total_cost_usd,
        });

        if (!hadConfirmations && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "response",
            text: cleanedText,
            agent: orcAgent,
            memoryId: orcMemoryId,
            ts: Date.now(),
            duration_ms: result.artifacts.total_duration_ms,
          }));
        }

        if (result.finalDispatch) {
          resilientTask("syncResponse", "critical", () => syncResponse(supabase, result.finalDispatch!.session_id, cleanedText, {
            duration_ms: result.artifacts.total_duration_ms,
          }));
        }

        // Fire playbook commands async (ELLIE:: tags)
        if (ellieChatOrcPlaybookCmds.length > 0) {
          const pbCtx: PlaybookContext = { bot, supabase, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, channel: "ellie-chat", callClaudeFn: callClaude, buildPromptFn: buildPrompt };
          resilientTask("executePlaybookCommands", "best-effort", () => executePlaybookCommands(ellieChatOrcPlaybookCmds, pbCtx));
        }

        // Post-message psy assessment (ELLIE-330)
        resilientTask("runPostMessageAssessment", "best-effort", () => runPostMessageAssessment(effectiveText, cleanedText, anthropic));
      } catch (err) {
        logger.error("Multi-step failed", err);
        const errMsg = err instanceof PipelineStepError && err.partialOutput
          ? err.partialOutput + "\n\n(Execution incomplete.)"
          : "Sorry, I ran into an error processing your multi-step request.";

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "response",
            text: errMsg,
            agent: agentResult.dispatch.agent.name || "general",
            ts: Date.now(),
          }));
        }
      }

      // Cleanup temp image file
      if (imagePath) unlink(imagePath).catch(() => {});

      resetEllieChatIdleTimer();
      return;
    }

    // ── Single-agent path ──
    // ELLIE-327: Apply auto-refresh results to context variables
    const ecStructured = ecRefreshResults["structured-context"] || structuredContext;
    const ecDocket = ecRefreshResults["context-docket"] || contextDocket;
    const ecForestAwareness = ecRefreshResults["forest-awareness"] || liveForest.awareness;
    const ecAgentMem = ecRefreshResults["agent-memory"] || agentMemory.memoryContext;

    // ELLIE-250 Phase 3: Proactive conflict detection + cross-channel sync
    const contextSectionsForCheck = [
      { label: "structured-context", content: ecStructured || "" },
      { label: "context-docket", content: ecDocket || "" },
      { label: "work-item", content: workItemContext || "" },
      { label: "forest-awareness", content: ecForestAwareness || "" },
    ];
    const ecGroundTruthResults = await Promise.allSettled([
      checkGroundTruthConflicts(effectiveText, contextSectionsForCheck),
      buildCrossChannelSection(supabase, "ellie-chat"),
    ]);
    const ecGroundTruthConflicts = ecGroundTruthResults[0].status === "fulfilled" ? ecGroundTruthResults[0].value : "";
    const ecCrossChannel = ecGroundTruthResults[1].status === "fulfilled" ? ecGroundTruthResults[1].value : "";
    if (ecGroundTruthResults[0].status === "rejected") logger.warn("[ellie-chat] Ground truth check failed", { error: ecGroundTruthResults[0].reason });
    if (ecGroundTruthResults[1].status === "rejected") logger.warn("[ellie-chat] Cross-channel check failed", { error: ecGroundTruthResults[1].reason });

    // ELLIE-541: Populate working memory cache so buildPrompt can inject session context
    const _ecAgentName = agentResult?.dispatch.agent?.name || "general";
    try { await primeWorkingMemoryCache(session.sessionId, _ecAgentName); } catch { /* non-critical */ }

    // ELLIE-590: Set pending commitments context for prompt injection
    setPendingCommitmentsContext(session.sessionId, 0);
    // Prime commitment follow-up cache so buildPrompt can inject it (ELLIE-339)
    await getCommitmentFollowUpContext(supabase).catch(() => {});
    // Prime cognitive load cache so buildPrompt can inject it (ELLIE-338)
    await getCognitiveLoadContext(supabase).catch(() => {});

    // ── COORDINATOR_MODE: async fire-and-forget coordinator path (ELLIE-1098) ──
    // Ack immediately, run coordinator in background, deliver via WebSocket when done.
    // This frees the message queue so new user messages can be processed.
    if (process.env.COORDINATOR_MODE === "true") {
      // Ack: tell the user we're on it
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "typing", agent: "ellie" }));
      }

      // Fire-and-forget: coordinator runs outside the queue
      const coordSessionId = session.sessionId || agentResult?.dispatch.session_id || `ec-${Date.now()}`;
      const coordMessage = effectiveText || text;
      const coordWorkItem = ellieChatWorkItem || undefined;
      const coordAgentModel = agentResult?.dispatch.agent?.model;

      (async () => {
        let typingInterval: ReturnType<typeof setInterval> | undefined;
        try {
          typingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "typing", ts: Date.now(), channelId, agent: "ellie" }));
            }
          }, 4_000);

          const foundationRegistry = await getFoundationRegistry();
          const coordinatorDeps = buildCoordinatorDeps({
            sessionId: coordSessionId,
            channel: "ellie-chat",
            sendFn: async (_ch: string, msg: string) => {
              try {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: "progress", text: msg, agent: "ellie", ts: Date.now() }));
                }
              } catch (err) {
                log.warn("Failed to send coordinator progress via WebSocket", { error: String(err) });
              }
            },
            // ELLIE-1099: Send spawn events to dashboard for agent activity indicators
            sendEventFn: async (event: Record<string, unknown>) => {
              try {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify(event));
                }
              } catch { /* best-effort */ }
            },
            forestReadFn: async (query: string) => {
              try {
                const resp = await fetch("http://localhost:3001/api/bridge/read", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "x-bridge-key": process.env.BRIDGE_KEY || "",
                  },
                  body: JSON.stringify({ query, scope_path: "2" }),
                });
                const data = await resp.json() as { memories?: Array<{ content: string }> };
                return data.memories?.map(m => m.content).join("\n") || "No results.";
              } catch {
                return "";
              }
            },
            registry: foundationRegistry || undefined,
          });

          // ELLIE-1159: Consume oldest pending ask_user (FIFO queue)
          const resumeState = shiftPendingAskUser();
          if (resumeState) {
            log.info("[coordinator] Resuming from ask_user pause", { question: resumeState.question.slice(0, 100), queueRemaining: getPendingAskUserCount() });
          }

          const coordinatorResult = await runCoordinatorLoop({
            message: coordMessage,
            channel: "ellie-chat",
            userId: "dashboard",
            registry: foundationRegistry || undefined,
            foundation: foundationRegistry?.getActive()?.name || "software-dev",
            systemPrompt: (foundationRegistry ? await foundationRegistry.getCoordinatorPrompt() : null) || "You are Ellie, a coordinator for Dave. Dispatch specialists for capabilities you don't have.",
            model: foundationRegistry?.getBehavior()?.coordinator_model || coordAgentModel || "claude-sonnet-4-6",
            agentRoster: foundationRegistry?.getAgentRoster() || ["james", "brian", "kate", "alan", "jason", "amy", "marcus"],
            deps: coordinatorDeps,
            workItemId: coordWorkItem,
            resumeState: resumeState || undefined,
          });

          // ELLIE-1159: Push paused state onto FIFO queue (not overwrite)
          if (coordinatorResult.paused) {
            pushPendingAskUser(coordinatorResult.paused);
            log.info("[coordinator] Paused for ask_user", { question: coordinatorResult.paused.question.slice(0, 100), queueDepth: getPendingAskUserCount() });
            // The question was already sent to the user by the coordinator's sendMessage
            // Don't send a "response" — just save the question as a message
            await saveMessage("assistant", coordinatorResult.response, {}, "ellie-chat", ecUserId);
            return;
          }

          // ELLIE-1133: Delete dispatch confirm message now that dispatch is complete
          if (dispatchConfirmMsgId) {
            const notifyCtx = getNotifyCtx();
            notifyCtx.bot.api.deleteMessage(notifyCtx.telegramUserId, dispatchConfirmMsgId).catch(() => {});
          }

          const coordResponse = coordinatorResult.response || "I completed the request but didn't generate a response. Please try again.";
          // ELLIE-1097: Use deliverResponse instead of raw ws.send — buffers on disconnect
          const memoryId = await saveMessage("assistant", coordResponse, {}, "ellie-chat", ecUserId);
          deliverResponse(ws, {
            type: "response",
            text: coordResponse,
            agent: "ellie",
            memoryId: memoryId || undefined,
            ts: Date.now(),
            duration_ms: coordinatorResult.durationMs,
          }, ecUserId);
          log.info(
            `[coordinator] ellie-chat complete — iterations=${coordinatorResult.loopIterations} ` +
            `tokens_in=${coordinatorResult.totalTokensIn} tokens_out=${coordinatorResult.totalTokensOut} ` +
            `cost=$${coordinatorResult.totalCostUsd.toFixed(4)} duration=${coordinatorResult.durationMs}ms`
          );
        } catch (coordErr) {
          log.error(`[coordinator] background error:`, coordErr);
          deliverResponse(ws, {
            type: "response",
            text: "Something went wrong while coordinating. Please try again.",
            agent: "ellie",
            ts: Date.now(),
          }, ecUserId);
        } finally {
          if (typingInterval) clearInterval(typingInterval);
        }
      })().catch(err => log.error("[coordinator] uncaught background error:", err));

      // Return immediately — queue is freed, coordinator runs in background
      return;
    }

    // ELLIE-1028: Fetch per-agent local memory for prompt injection
    const ecAgentLocalMemory = await getAgentMemorySummary(ellieChatActiveAgent, 2000).catch(() => "");

    // EI system: Analyze empathy needs and store emotion history
    const empathyGuidance = ecUserId
      ? await analyzeAndStoreEmpathy(supabase, ecUserId, effectiveText, "ellie-chat", session.conversationId).catch(() => null)
      : null;

    const enrichedPrompt = await buildPrompt(
      effectiveText, ecDocket, relevantContext, elasticContext, "ellie-chat",
      agentResult?.dispatch.agent ? {
        system_prompt: agentResult.dispatch.agent.system_prompt,
        name: agentResult.dispatch.agent.name,
        tools_enabled: agentResult.dispatch.agent.tools_enabled,
      } : undefined,
      workItemContext || undefined, ecStructured, recentMessages,
      agentResult?.dispatch.skill_context,
      forestContext,
      ecAgentMem || undefined,
      agentMemory.sessionIds,
      shouldFetch("archetype") ? await getAgentArchetype(agentResult?.dispatch.agent?.name) : undefined,
      shouldFetch("archetype") ? await getAgentRoleContext(agentResult?.dispatch.agent?.name) : undefined,
      shouldFetch("psy") ? await getPsyContext() : undefined,
      shouldFetch("phase") ? await getPhaseContext() : undefined,
      await getHealthContext(),
      ecQueueContext || undefined,
      liveForest.incidents || undefined,
      ecForestAwareness || undefined,
      (await getSkillSnapshot(ecCreatureProfile?.allowed_skills, effectiveText)).prompt || undefined,
      contextMode,
      ecRefreshed,
      channelProfile,
      ecGroundTruthConflicts || undefined,
      ecCrossChannel || undefined,
      commandBarContext,
      undefined, // fullWorkingMemory
      empathyGuidance || undefined,
      ecAgentLocalMemory || undefined,
    );

    capturePrompt({
      agentName: ellieChatActiveAgent || "general",
      channel: "ellie-chat",
      workItemId: ellieChatWorkItem || undefined,
      promptText: enrichedPrompt,
      tokenCount: Math.round(enrichedPrompt.length / 4),
    });

    // ── ELLIE-383: Context snapshot logging (journal only) ──
    const ecBuildMetrics = getLastBuildMetrics();
    if (ecBuildMetrics) {
      const top5 = [...ecBuildMetrics.sections].sort((a, b) => b.tokens - a.tokens).slice(0, 5);
      logger.info(
        `Context snapshot: creature=${ecBuildMetrics.creature || "general"} mode=${ecBuildMetrics.mode || "default"} ` +
        `tokens=${ecBuildMetrics.totalTokens} sections=${ecBuildMetrics.sectionCount} budget=${ecBuildMetrics.budget} ` +
        `top5=[${top5.map(s => `${s.label}:${s.tokens}`).join(", ")}]`
      );
    }

    const agentTools = agentResult?.dispatch.agent.tools_enabled;
    const agentModel = agentResult?.dispatch.agent.model;
    const startTime = Date.now();

    // Send typing heartbeat every 4s so the user knows we're still working
    const typingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "typing", ts: Date.now(), channelId, agent: agentResult?.dispatch?.agent?.name || "general" }));
      }
    }, 4_000);

    let rawResponse: string;
    try {
      rawResponse = await callClaude(enrichedPrompt, {
        resume: true,
        allowedTools: agentTools?.length ? agentTools : undefined,
        model: agentModel || undefined,
        timeoutMs: 900_000, // 15 min — async coordinator needs time for multi-step work
        // ELLIE-482: compose WS-disconnect signal (ELLIE-461) with queue-timeout signal
        abortSignal: abortSignal ? AbortSignal.any([abortSignal, queueSignal]) : queueSignal,
      });
      recordAnthropicSuccess();
    } catch (err) {
      clearInterval(typingInterval);
      if (isOutageError(err)) recordAnthropicFailure(err);
      if (isFallbackActive()) {
        if (consumeFallbackJustActivated()) {
          ws.send(JSON.stringify({
            type: "response",
            text: "⚡ Anthropic appears to be down. Switching to OpenAI (GPT-4o) for basic conversation. Complex tasks and tools are paused until Claude returns.",
            agent: "system",
            ts: Date.now(),
          }));
          notify(getNotifyCtx(), {
            event: "error",
            telegramMessage: "⚡ Anthropic outage — Ellie switched to OpenAI fallback",
          });
        }
        rawResponse = await callOpenAiFallback(effectiveText);
        rawResponse = `_(Running on GPT-4o — Claude unavailable)_\n\n${rawResponse}`;
      } else {
        throw err;
      }
    } finally {
      clearInterval(typingInterval);
    }

    // ELLIE-482: idempotency check — if queue timed out while callClaude was running,
    // the queue already moved on and logged a DLQ entry. Don't send a late response.
    if (queueSignal.aborted) {
      logger.warn("Queue timed out mid-dispatch — discarding late response to prevent duplicate");
      return;
    }

    // Aborted or empty dispatch — silently discard (user disconnected or signal was stale)
    if (!rawResponse || rawResponse.trim().length === 0) {
      logger.warn("Empty response from callClaude — likely aborted dispatch, discarding silently");
      return;
    }

    const durationMs = Date.now() - startTime;

    // If sessionIds weren't available at context-build time (tree created during agent run),
    // look up the most recently active tree for this agent's entity
    let effectiveSessionIds = agentMemory.sessionIds;
    if (!effectiveSessionIds && agentResult?.dispatch.agent.name) {
      try {
        const { default: forestSql } = await import('../../ellie-forest/src/db');
        const { getEntity } = await import('../../ellie-forest/src/index');
        const entityName = resolveEntityName(agentResult.dispatch.agent.name);
        const entity = await getEntity(entityName);
        if (entity) {
          // Find most recently active tree (growing or dormant within last 5 min)
          const [tree] = await forestSql<{ id: string; work_item_id: string | null }[]>`
            SELECT t.id, t.work_item_id FROM trees t
            JOIN creatures c ON c.tree_id = t.id
            WHERE t.type = 'work_session'
              AND t.state IN ('growing', 'dormant')
              AND t.last_activity > NOW() - INTERVAL '5 minutes'
              AND c.entity_id = ${entity.id}
            ORDER BY t.last_activity DESC LIMIT 1
          `;
          if (tree) {
            const [branch] = await forestSql<{ id: string }[]>`
              SELECT id FROM branches WHERE tree_id = ${tree.id} AND entity_id = ${entity.id} AND state = 'open' LIMIT 1
            `;
            const [creature] = await forestSql<{ id: string }[]>`
              SELECT id FROM creatures WHERE tree_id = ${tree.id} AND entity_id = ${entity.id}
              ORDER BY created_at DESC LIMIT 1
            `;
            effectiveSessionIds = {
              tree_id: tree.id,
              branch_id: branch?.id,
              creature_id: creature?.id,
              entity_id: entity.id,
              work_item_id: tree.work_item_id,
            };
            logger.info(`Late-resolved sessionIds: tree=${tree.id.slice(0, 8)}, creature=${creature?.id?.slice(0, 8) || 'none'}`);
          }
        }
      } catch (err: unknown) {
        logger.warn("Late-resolve sessionIds failed", { detail: err instanceof Error ? err.message : String(err) });
      }
    } else if (!effectiveSessionIds) {
      logger.info(`No sessionIds and no agent to late-resolve (agent=${agentResult?.dispatch.agent.name})`);
    }

    // ELLIE-528: Context pressure monitoring — general agent path
    const ecContextPressure = ecBuildMetrics ? checkContextPressure(ecBuildMetrics) : null;
    if (ecContextPressure && ecConvoId && shouldNotify(ecConvoId, ecContextPressure.level)) {
      rawResponse += getCompactionNotice(ecContextPressure);
      if (ecContextPressure.level === "critical" && ecBuildMetrics) {
        resilientTask("checkpointSessionToForest", "best-effort", () => checkpointSessionToForest({
          conversationId: ecConvoId,
          agentName: ellieChatActiveAgent || "general",
          mode: ecBuildMetrics.mode ?? contextMode,
          workItemId: ellieChatWorkItem,
          pressure: ecContextPressure,
          sections: ecBuildMetrics.sections,
          lastUserMessage: effectiveText,
        }));
      }
    }

    const response = await processMemoryIntents(supabase, rawResponse, agentResult?.dispatch.agent.name || "general", "shared", effectiveSessionIds);
    // ELLIE-649 Tier 2: Process response tags for conversation_facts
    const tier2Response = await import("./response-tag-processor.ts").then(m => m.processResponseTags(supabase, response, "ellie-chat"));
    // ELLIE-592: Detect conversational commitments in agent response
    detectAndLogCommitments(tier2Response, session.sessionId, 0);
    const { cleanedText: ecPlaybookClean, commands: ecPlaybookCmds } = extractPlaybookCommands(tier2Response);
    const ecAgent = agentResult?.dispatch.agent.name || "general";
    // ELLIE-389: Save first to get memoryId, then send with it
    const { cleanedText: ecPreClean } = extractApprovalTags(ecPlaybookClean);
    const ecMemoryId = await saveMessage("assistant", ecPreClean, { agent: ecAgent }, "ellie-chat", ecUserId);
    const { cleanedText, hadConfirmations } = sendWithApprovalsEllieChat(ws, ecPlaybookClean, session.sessionId, ecAgent, ecMemoryId);

    broadcastExtension({
      type: "message_out", channel: "ellie-chat",
      agent: ecAgent,
      preview: cleanedText.substring(0, 200),
    });

    if (!hadConfirmations) {
      deliverResponse(ws, {
        type: "response",
        text: cleanedText,
        agent: ecAgent,
        memoryId: ecMemoryId,
        ts: Date.now(),
        duration_ms: durationMs,
        channelId,
      });
    }
    clearProcessing(ecUserId || "anonymous");

    // ELLIE-846: Set agent back to idle after dispatch
    if (agentResult) {
      const dispatchedAgent = agentResult.dispatch.agent.name;
      updateAgentPresence(supabase, dispatchedAgent, "idle").catch(() => {});
      broadcastToEllieChatClients({
        type: "presence_update",
        agent_name: dispatchedAgent,
        status: "idle",
        channel_id: channelId,
        ts: Date.now(),
      });
    }

    if (agentResult) {
      resilientTask("syncResponse", "critical", () => syncResponse(supabase, agentResult!.dispatch.session_id, cleanedText, {
        duration_ms: durationMs,
      }));
    }

    // Fire playbook commands async (ELLIE:: tags)
    if (ecPlaybookCmds.length > 0) {
      const pbCtx: PlaybookContext = { bot, supabase, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, channel: "ellie-chat", callClaudeFn: callClaude, buildPromptFn: buildPrompt };
      resilientTask("executePlaybookCommands", "best-effort", () => executePlaybookCommands(ecPlaybookCmds, pbCtx));
    }

    // Post-message psy assessment (ELLIE-330)
    resilientTask("runPostMessageAssessment", "best-effort", () => runPostMessageAssessment(effectiveText, cleanedText, anthropic));

    // Cleanup temp image file
    if (imagePath) unlink(imagePath).catch(() => {});

    resetEllieChatIdleTimer();
  }, text.substring(0, 100));
}

// getSpecialistAck is imported from relay-utils.ts

/**
 * Run a specialist agent asynchronously (outside the ellie-chat queue).
 * ELLIE-479: WS-disconnect abort not used — specialist survives WS close since it's already acked.
 * ELLIE-482: queueSignal passed so specialist aborts if the queue times out.
 */
export async function runSpecialistAsync(
  ws: WebSocket,
  supabase: SupabaseClient | null,
  effectiveText: string,
  originalText: string,
  agentResult: { route: RouteResult; dispatch: DispatchResult },
  imagePath: string | undefined,
  workItemId: string | undefined,
  channelId?: string,
  channelProfile?: import("./api/mode-profile.ts").ChannelContextProfile | null,
  queueSignal?: AbortSignal,
): Promise<void> {
  const { bot, anthropic } = getRelayDeps();
  const agentName = agentResult.dispatch.agent.name;
  const specUser = wsAppUserMap.get(ws);
  const ecUserId = specUser?.id || specUser?.anonymous_id || undefined;
  const startTime = Date.now();
  logger.info(`Specialist ${agentName} starting async`);
  markProcessing(ecUserId || "anonymous", effectiveText);

  // ELLIE-440/446: Create job record (hoisted so catch block can update it)
  const runId = crypto.randomUUID();
  const agentTools = agentResult.dispatch.agent.tools_enabled;
  const agentModel = agentResult.dispatch.agent.model;
  const jobId = await createJob({
    type: "dispatch",
    source: "ellie-chat",
    work_item_id: workItemId,
    agent_type: agentName,
    model: agentModel || undefined,
    prompt_summary: effectiveText.slice(0, 200),
    tools_enabled: agentTools?.length ? agentTools : undefined,
    run_id: runId,
  }).catch((err) => { logger.error("Job creation failed", { agent: agentName, workItemId }, err); return null; });

  // Transition to running immediately — don't wait for context gathering
  if (jobId) {
    await updateJob(jobId, { status: "running", current_step: "gathering_context", last_heartbeat: new Date() });
    appendJobEvent(jobId, "running", { agent_type: agentName });
  }

  // ELLIE-589: Auto-log dispatch as pending commitment
  const dispatchTracking = trackDispatchStart(
    session.sessionId, agentName, workItemId,
    effectiveText.slice(0, 200), 0,
  );

  // Auto-approve Bash/Edit/Write for specialist runs (same as orchestration-dispatch)
  enterDispatchMode();
  try {
    // Typing heartbeat while specialist works; also touches job updated_at for orphan detection
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "typing", ts: Date.now(), channelId, agent: agentResult?.dispatch?.agent?.name || "general" }));
      } else {
        clearInterval(heartbeat);
      }
      if (jobId) updateJob(jobId, { last_heartbeat: new Date() });
    }, 4_000);

    // Gather context (same sources as sync path)
    const ellieChatActiveAgent = getActiveAgent("ellie-chat");
    const specConvoId = await getOrCreateConversation(supabase!, "ellie-chat", "general", channelId) || undefined;

    // ── ELLIE-325/334: Use channel profile or conversation mode ──
    const specConvoKey = specConvoId || "ellie-chat-default";
    const { contextMode: specContextMode } = resolveContextMode(specConvoKey, effectiveText, channelProfile);
    // Mode-aware fetch gating — skip sources that would be suppressed (priority >= 7)
    // ELLIE-367: creature priorities take precedence over mode priorities
    const shouldFetch = buildShouldFetch(specContextMode, ellieChatActiveAgent);
    const specCreatureProfile = getCreatureProfile(ellieChatActiveAgent); // needed for skill snapshot

    const { convoContext: specConvoContext, contextDocket, relevantContext, elasticContext, structuredContext, forestContext, agentMemory, queueContext: specQueueContext, liveForest } = await gatherContextSources(
      supabase, specConvoId, effectiveText, ellieChatActiveAgent, agentResult.dispatch, workItemId, shouldFetch,
    );
    const recentMessages = specConvoContext.text;
    if (agentResult.dispatch.is_new && specQueueContext) {
      resilientTask("acknowledgeQueueItems", "critical", () => acknowledgeQueueItems(ellieChatActiveAgent));
    }

    // Work item context
    let workItemContext = "";
    const workItemId2 = extractWorkItemId(effectiveText);
    const isWorkIntent = agentResult.route.skill_name === "code_changes" ||
      agentResult.route.skill_name === "code_review" ||
      agentResult.route.skill_name === "debugging";
    if (workItemId2 && isPlaneConfigured()) {
      const details = await fetchWorkItemDetails(workItemId2);
      if (details) {
        const label = isWorkIntent ? "ACTIVE WORK ITEM" : "REFERENCED WORK ITEM";
        workItemContext = `\n${label}: ${workItemId2}\n` +
          `Title: ${details.name}\n` +
          `Priority: ${details.priority}\n` +
          `Description: ${details.description}\n`;
      }
    }

    // ELLIE-250 Phase 3: Proactive conflict detection + cross-channel sync
    const specContextSections = [
      { label: "structured-context", content: structuredContext || "" },
      { label: "context-docket", content: contextDocket || "" },
      { label: "work-item", content: workItemContext || "" },
      { label: "forest-awareness", content: liveForest.awareness || "" },
    ];
    const ecSpecGroundTruthResults = await Promise.allSettled([
      checkGroundTruthConflicts(effectiveText, specContextSections),
      buildCrossChannelSection(supabase, "ellie-chat"),
    ]);
    const ecGroundTruthConflicts = ecSpecGroundTruthResults[0].status === "fulfilled" ? ecSpecGroundTruthResults[0].value : "";
    const ecCrossChannel = ecSpecGroundTruthResults[1].status === "fulfilled" ? ecSpecGroundTruthResults[1].value : "";
    if (ecSpecGroundTruthResults[0].status === "rejected") logger.warn("[ellie-chat-spec] Ground truth check failed", { error: ecSpecGroundTruthResults[0].reason });
    if (ecSpecGroundTruthResults[1].status === "rejected") logger.warn("[ellie-chat-spec] Cross-channel check failed", { error: ecSpecGroundTruthResults[1].reason });

    // ELLIE-541: Populate working memory cache so buildPrompt can inject session context
    try { await primeWorkingMemoryCache(session.sessionId, agentResult.dispatch.agent.name); } catch { /* non-critical */ }

    // ELLIE-590: Set pending commitments context for prompt injection
    setPendingCommitmentsContext(session.sessionId, 0);

    // ELLIE-1028: Fetch per-agent local memory for specialist prompt injection
    const specAgentLocalMemory = await getAgentMemorySummary(ellieChatActiveAgent, 2000).catch(() => "");

    // EI system: Analyze empathy needs and store emotion history
    const specEmpathyGuidance = ecUserId
      ? await analyzeAndStoreEmpathy(supabase, ecUserId, effectiveText, "ellie-chat", session.conversationId).catch(() => null)
      : null;

    const enrichedPrompt = await buildPrompt(
      effectiveText, contextDocket, relevantContext, elasticContext, "ellie-chat",
      {
        system_prompt: agentResult.dispatch.agent.system_prompt,
        name: agentResult.dispatch.agent.name,
        tools_enabled: agentResult.dispatch.agent.tools_enabled,
      },
      workItemContext || undefined, structuredContext, recentMessages,
      agentResult.dispatch.skill_context,
      forestContext,
      agentMemory.memoryContext || undefined,
      agentMemory.sessionIds,
      shouldFetch("archetype") ? await getAgentArchetype(agentResult.dispatch.agent.name) : undefined,
      shouldFetch("archetype") ? await getAgentRoleContext(agentResult.dispatch.agent.name) : undefined,
      shouldFetch("psy") ? await getPsyContext() : undefined,
      shouldFetch("phase") ? await getPhaseContext() : undefined,
      await getHealthContext(),
      specQueueContext || undefined,
      liveForest.incidents || undefined,
      liveForest.awareness || undefined,
      (await getSkillSnapshot(specCreatureProfile?.allowed_skills, effectiveText)).prompt || undefined,
      specContextMode,
      undefined, // refreshedSources
      channelProfile,
      ecGroundTruthConflicts || undefined,
      ecCrossChannel || undefined,
      undefined, // commandBarContext
      undefined, // fullWorkingMemory
      specEmpathyGuidance || undefined,
      specAgentLocalMemory || undefined,
    );

    capturePrompt({
      agentName: agentName || "general",
      channel: "ellie-chat",
      workItemId: workItemId || undefined,
      promptText: enrichedPrompt,
      tokenCount: Math.round(enrichedPrompt.length / 4),
    });

    // ── ELLIE-383: Context snapshot logging for specialist (journal only) ──
    const specBuildMetrics = getLastBuildMetrics();
    if (specBuildMetrics) {
      const top5 = [...specBuildMetrics.sections].sort((a, b) => b.tokens - a.tokens).slice(0, 5);
      logger.info(
        `Context snapshot: creature=${specBuildMetrics.creature || "general"} mode=${specBuildMetrics.mode || "default"} ` +
        `tokens=${specBuildMetrics.totalTokens} sections=${specBuildMetrics.sectionCount} budget=${specBuildMetrics.budget} ` +
        `top5=[${top5.map(s => `${s.label}:${s.tokens}`).join(", ")}]`
      );
    }

    // ELLIE-450: Check context pressure and notify Dave if approaching budget ceiling
    const contextPressure = specBuildMetrics ? checkContextPressure(specBuildMetrics) : null;

    if (jobId) {
      // Bug 4: increment completed_steps when context gathering finishes
      updateJob(jobId, { current_step: "calling_claude", model: agentModel || undefined, last_heartbeat: new Date(), increment_completed_steps: 1 });
      appendJobEvent(jobId, "calling_claude", { agent_type: agentName, model: agentModel });
    }

    let rawResponse: string;
    try {
      rawResponse = await callClaude(enrichedPrompt, {
        resume: false, // own session — doesn't pollute the general agent's context
        allowedTools: agentTools?.length ? agentTools : undefined,
        model: agentModel || undefined,
        timeoutMs: 900_000, // 15 min — specialists may do multi-step tool use
        // ELLIE-479: No WS-disconnect abort — specialist work survives WS close
        // ELLIE-482: but DO abort on queue timeout to prevent double responses
        abortSignal: queueSignal,
      });
      recordAnthropicSuccess();
    } catch (err) {
      clearInterval(heartbeat);
      // ELLIE-589: Mark dispatch commitment as failed
      trackDispatchFailure(session.sessionId, dispatchTracking.commitmentId);
      if (isOutageError(err)) recordAnthropicFailure(err);
      if (isFallbackActive()) {
        // Specialists need tools — just let the user know to retry when Claude returns
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "response",
            text: "⚡ Claude is currently unavailable. This task requires the specialist agent — I'll be ready to help once Claude is back.",
            agent: agentName,
            ts: Date.now(),
          }));
        }
        return;
      }
      throw err;
    } finally {
      clearInterval(heartbeat);
    }

    // ELLIE-482: idempotency check — queue timed out, don't send late specialist response
    if (queueSignal?.aborted) {
      logger.warn("Queue timed out mid-specialist — discarding late response to prevent duplicate", { agentName });
      // ELLIE-589: Mark dispatch commitment as timed_out on queue abort
      trackDispatchFailure(session.sessionId, dispatchTracking.commitmentId);
      return;
    }

    // Aborted or empty specialist dispatch — discard silently
    if (!rawResponse || rawResponse.trim().length === 0) {
      logger.warn("Empty specialist response — likely aborted dispatch", { agentName });
      return;
    }

    const durationMs = Date.now() - startTime;
    logger.info(`Specialist ${agentName} completed in ${durationMs}ms`);
    if (jobId) {
      // ELLIE-445: Verify dev agents actually produced file changes before marking completed
      const { verified, note } = await verifyJobWork(agentName, startTime);
      const finalStatus = verified ? "completed" : "responded";
      // ELLIE-446: Populate token + cost accounting
      // Bug 1: use specBuildMetrics captured before the Claude call, not getLastBuildMetrics()
      // which is a global that any concurrent request could have overwritten during the run
      const tokensIn = specBuildMetrics?.totalTokens ?? 0;
      const tokensOut = estimateTokens(rawResponse, agentModel ?? undefined);
      const costUsd = estimateJobCost(agentModel, tokensIn, tokensOut);
      updateJob(jobId, {
        status: finalStatus, total_duration_ms: durationMs, current_step: null,
        tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: costUsd,
        increment_completed_steps: 1, // Bug 4: Claude call done
        result: { response_length: rawResponse.length },
      });
      // Bug 3: duration_ms belongs in opts (4th param), not details
      appendJobEvent(jobId, finalStatus, { verified, verification_note: note }, { duration_ms: durationMs });
      if (!verified) {
        logger.info(`Job ${jobId.slice(0, 8)} marked 'responded' — ${note}`);
      }
    }

    // ELLIE-589: Resolve dispatch commitment on success
    trackDispatchComplete(session.sessionId, dispatchTracking.commitmentId, 1);

    // ELLIE-450: Append compaction notice and async-checkpoint if threshold crossed
    if (contextPressure && specConvoId && shouldNotify(specConvoId, contextPressure.level)) {
      rawResponse += getCompactionNotice(contextPressure);
      if (contextPressure.level === "critical" && specBuildMetrics) {
        resilientTask("checkpointSessionToForest", "best-effort", () => checkpointSessionToForest({
          conversationId: specConvoId,
          agentName,
          mode: specBuildMetrics.mode ?? specContextMode,
          workItemId,
          pressure: contextPressure,
          sections: specBuildMetrics.sections,
          lastUserMessage: effectiveText,
        }));
      }
    }

    const response = await processMemoryIntents(supabase, rawResponse, agentName, "shared", agentMemory.sessionIds);
    // ELLIE-649 Tier 2: Process response tags for conversation_facts
    const tier2Spec = await import("./response-tag-processor.ts").then(m => m.processResponseTags(supabase, response, "ellie-chat"));
    // ELLIE-592: Detect conversational commitments in specialist response
    detectAndLogCommitments(tier2Spec, session.sessionId, 0);
    const { cleanedText: playClean, commands: playCmds } = extractPlaybookCommands(tier2Spec);
    // ELLIE-389: Save first to get memoryId, then send with it
    const { cleanedText: specPreClean } = extractApprovalTags(playClean);
    const specMemoryId = await saveMessage("assistant", specPreClean, { agent: agentName }, "ellie-chat", ecUserId);
    const { cleanedText, hadConfirmations } = sendWithApprovalsEllieChat(ws, playClean, session.sessionId, agentName, specMemoryId);

    broadcastExtension({
      type: "message_out", channel: "ellie-chat",
      agent: agentName,
      preview: cleanedText.substring(0, 200),
    });

    if (!hadConfirmations) {
      const payload = {
        type: "response" as const,
        text: cleanedText,
        agent: agentName,
        memoryId: specMemoryId,
        ts: Date.now(),
        duration_ms: durationMs,
        channelId,
      };
      const sent = deliverResponse(ws, payload);
      if (!sent) {
        // Original WS closed — send to same user's other connections only (ELLIE-197)
        const json = JSON.stringify(payload);
        for (const client of ellieChatClients) {
          if (client.readyState === WebSocket.OPEN) {
            const clientUser = wsAppUserMap.get(client);
            const clientAppId = clientUser?.id || clientUser?.anonymous_id;
            if (clientAppId && clientAppId === ecUserId) {
              client.send(json);
            }
          }
        }
      }
    }
    clearProcessing(ecUserId || "anonymous");
    exitDispatchMode();

    if (agentResult?.dispatch?.session_id) {
      const sessionId = agentResult.dispatch.session_id; // Capture before async callback
      resilientTask("syncResponse", "critical", () => syncResponse(supabase, sessionId, cleanedText, {
        duration_ms: durationMs,
      }));
    }

    // Fire playbook commands async (ELLIE:: tags)
    if (playCmds.length > 0) {
      const pbCtx: PlaybookContext = { bot, supabase, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, channel: "ellie-chat", callClaudeFn: callClaude, buildPromptFn: buildPrompt };
      resilientTask("executePlaybookCommands", "best-effort", () => executePlaybookCommands(playCmds, pbCtx));
    }

    // Post-message psy assessment (ELLIE-330)
    resilientTask("runPostMessageAssessment", "best-effort", () => runPostMessageAssessment(effectiveText, cleanedText, anthropic));

    // Cleanup temp image file
    if (imagePath) unlink(imagePath).catch(() => {});
  } catch (err) {
    const durationMs = Date.now() - startTime;
    logger.error("Specialist failed", { agent: agentName, durationMs }, err);
    if (jobId) {
      updateJob(jobId, { status: "failed", total_duration_ms: durationMs, error_count: 1, current_step: null });
      appendJobEvent(jobId, "failed", { error: err instanceof Error ? err.message.slice(0, 500) : String(err) });
    }
    const errorMsg = `Sorry, the ${agentName} specialist ran into an issue. You can try again or rephrase.`;
    const errMemoryId = await saveMessage("assistant", errorMsg, {}, "ellie-chat", ecUserId).catch(() => null);
    deliverResponse(ws, { type: "response", text: errorMsg, agent: agentName, memoryId: errMemoryId, ts: Date.now(), channelId });
    clearProcessing(ecUserId || "anonymous");
    exitDispatchMode();
  }
}
