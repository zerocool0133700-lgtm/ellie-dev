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
  getContextDocket,
} from "./relay-config.ts";
import {
  getActiveAgent, setActiveAgent,
  wsAppUserMap, ellieChatPhoneHistories, ellieChatClients,
  broadcastExtension, getRelayDeps, getNotifyCtx,
} from "./relay-state.ts";
import { resetEllieChatIdleTimer, resetTelegramIdleTimer, resetGchatIdleTimer } from "./relay-idle.ts";
import { textToSpeechFast } from "./tts.ts";
import {
  buildPrompt,
  runPostMessageAssessment,
  getPlanningMode,
  setPlanningMode,
  USER_NAME,
  getArchetypeContext,
  getPsyContext,
  getPhaseContext,
  getHealthContext,
} from "./prompt-builder.ts";
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
  type RouteResult,
  type DispatchResult,
} from "./agent-router.ts";
import { getSkillSnapshot } from "./skills/index.ts";
import {
  getSpecialistAck,
  estimateTokens,
  trimSearchContext,
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

export async function handleEllieChatMessage(
  ws: WebSocket,
  text: string,
  phoneMode: boolean = false,
  image?: { data: string; mime_type: string; name: string },
): Promise<void> {
  const { bot, anthropic, supabase } = getRelayDeps();
  console.log(`[ellie-chat] User${phoneMode ? " (phone)" : ""}${image ? " [+image]" : ""}: ${text.substring(0, 80)}...`);
  acknowledgeChannel("ellie-chat");

  const ecUser = wsAppUserMap.get(ws);
  const ecUserId = ecUser?.id || ecUser?.anonymous_id || undefined;

  await saveMessage("user", text, image ? { image_name: image.name, image_mime: image.mime_type } : {}, "ellie-chat", ecUserId);
  broadcastExtension({ type: "message_in", channel: "ellie-chat", preview: text.substring(0, 200) });

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
      console.log(`[ellie-chat] Image saved: ${imagePath} (${image.name})`);
    } catch (err) {
      console.error("[ellie-chat] Failed to save image:", err);
      imagePath = null;
    }
  }

  // Send typing indicator
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "typing", ts: Date.now() }));
  }

  // /plan on|off — toggle planning mode
  const ecPlanMatch = text.match(/^\/plan\s+(on|off)$/i);
  if (ecPlanMatch) {
    setPlanningMode(ecPlanMatch[1].toLowerCase() === "on");
    const msg = getPlanningMode()
      ? "Planning mode ON — conversation will persist for up to 60 minutes of idle time."
      : "Planning mode OFF — reverting to 10-minute idle timeout.";
    console.log(`[planning] ${msg}`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "response", text: msg, agent: "system", ts: Date.now() }));
    }
    resetTelegramIdleTimer();
    resetGchatIdleTimer();
    resetEllieChatIdleTimer();
    broadcastExtension({ type: "planning_mode", active: getPlanningMode() });
    return;
  }

  // /ticket — create Plane ticket from context
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
          contextMessages = (recent || []).reverse().map((m: any) => `[${m.role}]: ${m.content}`);
        } else {
          contextMessages = ["No context available"];
        }

        const context = contextMessages.join("\n---\n");
        const prompt = `Generate a Plane project ticket from this context. Return ONLY valid JSON with no markdown formatting:\n{"title": "concise title under 80 chars", "description": "detailed description with requirements as bullet points", "priority": "medium"}\n\nPriority must be one of: urgent, high, medium, low, none.\n\nContext:\n${context}`;

        console.log(`[ticket] /ticket command — generating from ${ticketText ? "user text" : "last 5 messages"}...`);
        const raw = await callClaude(prompt);
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("Could not parse ticket JSON");
        const ticket = JSON.parse(jsonMatch[0]);

        const result = await createPlaneIssue("ELLIE", ticket.title, ticket.description, ticket.priority);
        if (!result) throw new Error("Plane API failed");

        const msg = `Created ${result.identifier}: ${ticket.title}`;
        console.log(`[ticket] ${msg}`);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "response", text: msg, agent: "system", ts: Date.now() }));
        }
      } catch (err: any) {
        console.error("[ticket] /ticket error:", err?.message);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "response", text: `Failed to create ticket: ${err?.message?.slice(0, 200) || "unknown error"}`, agent: "system", ts: Date.now() }));
        }
      }
    })();
    return;
  }

  // ELLIE:: user-typed commands — bypass classifier, execute directly
  const { cleanedText: ellieChatPlaybookClean, commands: ellieChatPlaybookCmds } = extractPlaybookCommands(text);
  if (ellieChatPlaybookCmds.length > 0) {
    console.log(`[ellie-chat] ELLIE:: commands in user message: ${ellieChatPlaybookCmds.map(c => c.type).join(", ")}`);
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
        console.error("[playbook]", err);
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
          const verifyHist = ellieChatPhoneHistories.get(verifyHistKey)!;
          verifyHist.push({ role: "user", content: text });
          verifyHist.push({ role: "assistant", content: `Perfect, ${appUser.name || 'friend'}! Your account is verified. I'll remember our conversations from now on.` });
          console.log(`[ellie-chat] Code verified for ${appUser.email} — session upgraded`);
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
        console.error("[ellie-chat] Code detection error:", err);
      }
    }, "code-verify");
    // If code was valid, we already sent the response — check if state changed
    const updatedUser = wsAppUserMap.get(ws);
    if (updatedUser && updatedUser.onboarding_state === 'verified') return;
  }

  if (phoneMode) {
    // ── Phone mode fast path: 6-turn context, Haiku, brevity prompt, no agent routing ──
    await enqueueEllieChat(async () => {
      // Per-user phone history (ELLIE-197)
      const phoneHistKey = ecUserId || 'anonymous';
      if (!ellieChatPhoneHistories.has(phoneHistKey)) ellieChatPhoneHistories.set(phoneHistKey, []);
      const phoneHistory = ellieChatPhoneHistories.get(phoneHistKey)!;
      phoneHistory.push({ role: "user", content: text });

      const conversationContext = phoneHistory
        .slice(-6)
        .map(m => `${m.role}: ${m.content}`)
        .join("\n");

      // Lightweight context — skip structured context, recent messages, agent routing
      const [contextDocket, relevantContext, elasticContext] = await Promise.all([
        getContextDocket(),
        getRelevantContext(supabase, text, "ellie-chat", getActiveAgent("ellie-chat")),
        searchElastic(text, { limit: 3, recencyBoost: true, channel: "ellie-chat", sourceAgent: getActiveAgent("ellie-chat") }),
      ]);

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

      // Process ELLIE:: onboarding commands (ELLIE-176)
      let responseText = rawResponse.trim();
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
                console.log(`[ellie-chat] SET_NAME: ${name}`);
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
                console.log(`[ellie-chat] REQUEST_EMAIL: code sent to ${email}`);
              }
            }

            if (cmd.startsWith('ELLIE::SET_TIMEZONE ')) {
              const tz = cmd.replace('ELLIE::SET_TIMEZONE ', '').trim();
              if (tz && wsUser.id) {
                await forestSql`UPDATE app_users SET timezone = ${tz} WHERE id = ${wsUser.id}`;
                console.log(`[ellie-chat] SET_TIMEZONE: ${tz}`);
              }
            }

            if (cmd.startsWith('ELLIE::ONBOARDING_COMPLETE')) {
              if (wsUser.id) {
                await forestSql`UPDATE app_users SET onboarding_state = 'onboarded' WHERE id = ${wsUser.id}`;
                wsUser.onboarding_state = 'onboarded';
                wsAppUserMap.set(ws, wsUser);
                console.log(`[ellie-chat] ONBOARDING_COMPLETE for ${wsUser.name}`);
              }
            }
          } catch (err) {
            console.error(`[ellie-chat] ELLIE:: command error (${cmd}):`, err);
          }
        }
      }

      const cleanedText = responseText;
      phoneHistory.push({ role: "assistant", content: cleanedText });

      // Cap per-user history at 20 entries to prevent memory growth
      if (phoneHistory.length > 20) phoneHistory.splice(0, phoneHistory.length - 20);

      await saveMessage("assistant", cleanedText, {}, "ellie-chat", ecUserId);
      broadcastExtension({
        type: "message_out", channel: "ellie-chat",
        agent: "general",
        preview: cleanedText.substring(0, 200),
      });

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "response",
          text: cleanedText,
          agent: "general",
          ts: Date.now(),
          duration_ms: durationMs,
        }));
      }

      resetEllieChatIdleTimer();
    }, text.substring(0, 100));
    return;
  }

  // ── Normal text mode: full agent routing + context gathering (mirrors Google Chat) ──
  await enqueueEllieChat(async () => {
    const ellieChatWorkItem = text.match(/\b([A-Z]+-\d+)\b/)?.[1];
    const agentResult = await routeAndDispatch(supabase, text, "ellie-chat", "dashboard", ellieChatWorkItem);
    let effectiveText = agentResult?.route.strippedMessage || text;
    // Prepend image file reference so Claude Code CLI can see the image
    if (imagePath) {
      effectiveText = `[Image: ${imagePath}]\n\n${effectiveText || "Analyze this image."}`;
    }
    if (agentResult) {
      setActiveAgent("ellie-chat", agentResult.dispatch.agent.name);
      broadcastExtension({
        type: "route", channel: "ellie-chat",
        agent: agentResult.dispatch.agent.name,
        mode: agentResult.route.execution_mode,
      });

      // Dispatch notification (ELLIE-80 pattern from Google Chat)
      if (agentResult.dispatch.agent.name !== "general" && agentResult.dispatch.is_new) {
        notify(getNotifyCtx(), {
          event: "dispatch_confirm",
          workItemId: agentResult.dispatch.agent.name,
          telegramMessage: `🤖 ${agentResult.dispatch.agent.name} agent`,
          gchatMessage: `🤖 ${agentResult.dispatch.agent.name} agent dispatched`,
        }).catch((err) => console.error("[notify] dispatch_confirm:", err.message));
      }
    }

    // ── ASYNC SPECIALIST PATH: ack immediately, run in background ──
    const ecRouteAgent = agentResult?.dispatch?.agent?.name || "general";
    const isSpecialist = ecRouteAgent !== "general";
    const isMultiStep = agentResult?.route.execution_mode !== "single" && agentResult?.route.skills?.length;

    if (isSpecialist && !isMultiStep && agentResult) {
      const ack = getSpecialistAck(ecRouteAgent);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "response", text: ack, agent: "general", ts: Date.now() }));
      }
      await saveMessage("assistant", ack, {}, "ellie-chat", ecUserId);
      broadcastExtension({ type: "message_out", channel: "ellie-chat", agent: "general", preview: ack });

      // Fire-and-forget: specialist runs outside the queue
      runSpecialistAsync(ws, supabase, effectiveText, text, agentResult, imagePath, ellieChatWorkItem).catch(err => {
        console.error(`[ellie-chat] specialist async error:`, err);
      });

      resetEllieChatIdleTimer();
      return; // queue task done — queue is free for next message
    }

    const ellieChatActiveAgent = getActiveAgent("ellie-chat");
    const ecConvoId = await getOrCreateConversation(supabase!, "ellie-chat") || undefined;
    const [ecConvoContext, contextDocket, relevantContext, elasticContext, structuredContext, forestContext, agentMemory, ecQueueContext, liveForest] = await Promise.all([
      ecConvoId && supabase ? getConversationMessages(supabase, ecConvoId) : Promise.resolve({ text: "", messageCount: 0, conversationId: "" }),
      getContextDocket(),
      getRelevantContext(supabase, effectiveText, "ellie-chat", ellieChatActiveAgent, ecConvoId),
      searchElastic(effectiveText, { limit: 5, recencyBoost: true, channel: "ellie-chat", sourceAgent: ellieChatActiveAgent, excludeConversationId: ecConvoId }),
      getAgentStructuredContext(supabase, ellieChatActiveAgent),
      getForestContext(effectiveText),
      getAgentMemoryContext(ellieChatActiveAgent, ellieChatWorkItem, getMaxMemoriesForModel(agentResult?.dispatch.agent.model)),
      agentResult?.dispatch.is_new ? getQueueContext(ellieChatActiveAgent) : Promise.resolve(""),
      getLiveForestContext(effectiveText),
    ]);
    const recentMessages = ecConvoContext.text;
    if (agentResult?.dispatch.is_new && ecQueueContext) {
      acknowledgeQueueItems(ellieChatActiveAgent).catch(() => {});
    }

    // Detect work item mentions (ELLIE-5, EVE-3, etc.) — matches Telegram text handler
    let workItemContext = "";
    const workItemMatch = effectiveText.match(/\b([A-Z]+-\d+)\b/);
    const isEllieChatWorkIntent = agentResult?.route.skill_name === "code_changes" ||
      agentResult?.route.skill_name === "code_review" ||
      agentResult?.route.skill_name === "debugging";
    if (workItemMatch && isPlaneConfigured()) {
      const details = await fetchWorkItemDetails(workItemMatch[1]);
      if (details) {
        const label = isEllieChatWorkIntent ? "ACTIVE WORK ITEM" : "REFERENCED WORK ITEM";
        workItemContext = `\n${label}: ${workItemMatch[1]}\n` +
          `Title: ${details.name}\n` +
          `Priority: ${details.priority}\n` +
          `Description: ${details.description}\n`;
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
        const { cleanedText: ellieChatOrcPlaybookClean, commands: ellieChatOrcPlaybookCmds } = extractPlaybookCommands(pipelineResponse);
        const { cleanedText, hadConfirmations } = sendWithApprovalsEllieChat(ws, ellieChatOrcPlaybookClean, session.sessionId, orcAgent);

        await saveMessage("assistant", cleanedText, {}, "ellie-chat", ecUserId);
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
            ts: Date.now(),
            duration_ms: result.artifacts.total_duration_ms,
          }));
        }

        if (result.finalDispatch) {
          syncResponse(supabase, result.finalDispatch.session_id, cleanedText, {
            duration_ms: result.artifacts.total_duration_ms,
          }).catch(() => {});
        }

        // Fire playbook commands async (ELLIE:: tags)
        if (ellieChatOrcPlaybookCmds.length > 0) {
          const pbCtx: PlaybookContext = { bot, supabase, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, channel: "ellie-chat", callClaudeFn: callClaude, buildPromptFn: buildPrompt };
          executePlaybookCommands(ellieChatOrcPlaybookCmds, pbCtx).catch(err => console.error("[playbook]", err));
        }
      } catch (err) {
        console.error("[ellie-chat] Multi-step failed:", err);
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
    const enrichedPrompt = buildPrompt(
      effectiveText, contextDocket, relevantContext, elasticContext, "ellie-chat",
      agentResult?.dispatch.agent ? {
        system_prompt: agentResult.dispatch.agent.system_prompt,
        name: agentResult.dispatch.agent.name,
        tools_enabled: agentResult.dispatch.agent.tools_enabled,
      } : undefined,
      workItemContext || undefined, structuredContext, recentMessages,
      agentResult?.dispatch.skill_context,
      forestContext,
      agentMemory.memoryContext || undefined,
      agentMemory.sessionIds,
      await getArchetypeContext(),
      await getPsyContext(),
      await getPhaseContext(),
      await getHealthContext(),
      ecQueueContext || undefined,
      liveForest.incidents || undefined,
      liveForest.awareness || undefined,
      (await getSkillSnapshot()).prompt || undefined,
    );

    const agentTools = agentResult?.dispatch.agent.tools_enabled;
    const agentModel = agentResult?.dispatch.agent.model;
    const startTime = Date.now();

    // Send typing heartbeat every 4s so the user knows we're still working
    const typingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "typing", ts: Date.now() }));
      }
    }, 4_000);

    let rawResponse: string;
    try {
      rawResponse = await callClaude(enrichedPrompt, {
        resume: true,
        allowedTools: agentTools?.length ? agentTools : undefined,
        model: agentModel || undefined,
        timeoutMs: 600_000, // 10 min — async coordinator needs time for multi-step work
      });
    } finally {
      clearInterval(typingInterval);
    }
    const durationMs = Date.now() - startTime;

    // If sessionIds weren't available at context-build time (tree created during agent run),
    // look up the most recently active tree for this agent's entity
    let effectiveSessionIds = agentMemory.sessionIds;
    if (!effectiveSessionIds && agentResult?.dispatch.agent.name) {
      try {
        const { default: forestSql } = await import('../../ellie-forest/src/db');
        const { getEntity } = await import('../../ellie-forest/src/index');
        const AGENT_ENTITY_MAP: Record<string, string> = { dev: "dev_agent", general: "general_agent" };
        const entityName = AGENT_ENTITY_MAP[agentResult.dispatch.agent.name] ?? agentResult.dispatch.agent.name;
        const entity = await getEntity(entityName);
        if (entity) {
          // Find most recently active tree (growing or dormant within last 5 min)
          const [tree] = await forestSql<any[]>`
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
            console.log(`[ellie-chat] Late-resolved sessionIds: tree=${tree.id.slice(0, 8)}, creature=${creature?.id?.slice(0, 8) || 'none'}`);
          }
        }
      } catch (err: any) {
        console.warn(`[ellie-chat] Late-resolve sessionIds failed:`, err?.message || err);
      }
    } else if (!effectiveSessionIds) {
      console.log(`[ellie-chat] No sessionIds and no agent to late-resolve (agent=${agentResult?.dispatch.agent.name})`);
    }

    const response = await processMemoryIntents(supabase, rawResponse, agentResult?.dispatch.agent.name || "general", "shared", effectiveSessionIds);
    const { cleanedText: ecPlaybookClean, commands: ecPlaybookCmds } = extractPlaybookCommands(response);
    const ecAgent = agentResult?.dispatch.agent.name || "general";
    const { cleanedText, hadConfirmations } = sendWithApprovalsEllieChat(ws, ecPlaybookClean, session.sessionId, ecAgent);

    await saveMessage("assistant", cleanedText, {}, "ellie-chat", ecUserId);
    broadcastExtension({
      type: "message_out", channel: "ellie-chat",
      agent: ecAgent,
      preview: cleanedText.substring(0, 200),
    });

    if (!hadConfirmations && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "response",
        text: cleanedText,
        agent: ecAgent,
        ts: Date.now(),
        duration_ms: durationMs,
      }));
    }

    if (agentResult) {
      syncResponse(supabase, agentResult.dispatch.session_id, cleanedText, {
        duration_ms: durationMs,
      }).catch(() => {});
    }

    // Fire playbook commands async (ELLIE:: tags)
    if (ecPlaybookCmds.length > 0) {
      const pbCtx: PlaybookContext = { bot, supabase, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, channel: "ellie-chat", callClaudeFn: callClaude, buildPromptFn: buildPrompt };
      executePlaybookCommands(ecPlaybookCmds, pbCtx).catch(err => console.error("[playbook]", err));
    }

    // Cleanup temp image file
    if (imagePath) unlink(imagePath).catch(() => {});

    resetEllieChatIdleTimer();
  }, text.substring(0, 100));
}

// getSpecialistAck is imported from relay-utils.ts

/** Run a specialist agent asynchronously (outside the ellie-chat queue). */
export async function runSpecialistAsync(
  ws: WebSocket,
  supabase: SupabaseClient | null,
  effectiveText: string,
  originalText: string,
  agentResult: { route: RouteResult; dispatch: DispatchResult },
  imagePath: string | undefined,
  workItemId: string | undefined,
): Promise<void> {
  const { bot } = getRelayDeps();
  const agentName = agentResult.dispatch.agent.name;
  const specUser = wsAppUserMap.get(ws);
  const ecUserId = specUser?.id || specUser?.anonymous_id || undefined;
  const startTime = Date.now();
  console.log(`[ellie-chat] Specialist ${agentName} starting async`);

  try {
    // Typing heartbeat while specialist works
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "typing", ts: Date.now() }));
      } else {
        clearInterval(heartbeat);
      }
    }, 4_000);

    // Gather context (same sources as sync path)
    const ellieChatActiveAgent = getActiveAgent("ellie-chat");
    const specConvoId = await getOrCreateConversation(supabase!, "ellie-chat") || undefined;
    const [specConvoContext, contextDocket, relevantContext, elasticContext, structuredContext, forestContext, agentMemory, specQueueContext, liveForest] = await Promise.all([
      specConvoId && supabase ? getConversationMessages(supabase, specConvoId) : Promise.resolve({ text: "", messageCount: 0, conversationId: "" }),
      getContextDocket(),
      getRelevantContext(supabase, effectiveText, "ellie-chat", ellieChatActiveAgent, specConvoId),
      searchElastic(effectiveText, { limit: 5, recencyBoost: true, channel: "ellie-chat", sourceAgent: ellieChatActiveAgent, excludeConversationId: specConvoId }),
      getAgentStructuredContext(supabase, ellieChatActiveAgent),
      getForestContext(effectiveText),
      getAgentMemoryContext(ellieChatActiveAgent, workItemId, getMaxMemoriesForModel(agentResult.dispatch.agent.model)),
      agentResult.dispatch.is_new ? getQueueContext(ellieChatActiveAgent) : Promise.resolve(""),
      getLiveForestContext(effectiveText),
    ]);
    const recentMessages = specConvoContext.text;
    if (agentResult.dispatch.is_new && specQueueContext) {
      acknowledgeQueueItems(ellieChatActiveAgent).catch(() => {});
    }

    // Work item context
    let workItemContext = "";
    const workItemMatch = effectiveText.match(/\b([A-Z]+-\d+)\b/);
    const isWorkIntent = agentResult.route.skill_name === "code_changes" ||
      agentResult.route.skill_name === "code_review" ||
      agentResult.route.skill_name === "debugging";
    if (workItemMatch && isPlaneConfigured()) {
      const details = await fetchWorkItemDetails(workItemMatch[1]);
      if (details) {
        const label = isWorkIntent ? "ACTIVE WORK ITEM" : "REFERENCED WORK ITEM";
        workItemContext = `\n${label}: ${workItemMatch[1]}\n` +
          `Title: ${details.name}\n` +
          `Priority: ${details.priority}\n` +
          `Description: ${details.description}\n`;
      }
    }

    const enrichedPrompt = buildPrompt(
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
      await getArchetypeContext(),
      await getPsyContext(),
      await getPhaseContext(),
      await getHealthContext(),
      specQueueContext || undefined,
      liveForest.incidents || undefined,
      liveForest.awareness || undefined,
      (await getSkillSnapshot()).prompt || undefined,
    );

    const agentTools = agentResult.dispatch.agent.tools_enabled;
    const agentModel = agentResult.dispatch.agent.model;

    let rawResponse: string;
    try {
      rawResponse = await callClaude(enrichedPrompt, {
        resume: false, // own session — doesn't pollute the general agent's context
        allowedTools: agentTools?.length ? agentTools : undefined,
        model: agentModel || undefined,
        timeoutMs: 600_000, // 10 min — specialists may do multi-step tool use
      });
    } finally {
      clearInterval(heartbeat);
    }

    const durationMs = Date.now() - startTime;
    console.log(`[ellie-chat] Specialist ${agentName} completed in ${durationMs}ms`);

    const response = await processMemoryIntents(supabase, rawResponse, agentName, "shared", agentMemory.sessionIds);
    const { cleanedText: playClean, commands: playCmds } = extractPlaybookCommands(response);
    const { cleanedText, hadConfirmations } = sendWithApprovalsEllieChat(ws, playClean, session.sessionId, agentName);

    await saveMessage("assistant", cleanedText, {}, "ellie-chat", ecUserId);
    broadcastExtension({
      type: "message_out", channel: "ellie-chat",
      agent: agentName,
      preview: cleanedText.substring(0, 200),
    });

    if (!hadConfirmations && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "response",
        text: cleanedText,
        agent: agentName,
        ts: Date.now(),
        duration_ms: durationMs,
      }));
    } else if (!hadConfirmations) {
      // Original WS closed — send to same user's other connections only (ELLIE-197)
      const payload = JSON.stringify({
        type: "response", text: cleanedText, agent: agentName,
        ts: Date.now(), duration_ms: durationMs,
      });
      for (const client of ellieChatClients) {
        if (client.readyState === WebSocket.OPEN) {
          const clientUser = wsAppUserMap.get(client);
          const clientId = clientUser?.id || clientUser?.anonymous_id;
          if (clientId && clientId === ecUserId) {
            client.send(payload);
          }
        }
      }
    }

    syncResponse(supabase, agentResult.dispatch.session_id, cleanedText, {
      duration_ms: durationMs,
    }).catch(() => {});

    // Fire playbook commands async (ELLIE:: tags)
    if (playCmds.length > 0) {
      const pbCtx: PlaybookContext = { bot, supabase, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, channel: "ellie-chat", callClaudeFn: callClaude, buildPromptFn: buildPrompt };
      executePlaybookCommands(playCmds, pbCtx).catch(err => console.error("[playbook]", err));
    }

    // Cleanup temp image file
    if (imagePath) unlink(imagePath).catch(() => {});
  } catch (err) {
    const durationMs = Date.now() - startTime;
    console.error(`[ellie-chat] Specialist ${agentName} failed after ${durationMs}ms:`, err);
    const errorMsg = `Sorry, the ${agentName} specialist ran into an issue. You can try again or rephrase.`;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "response", text: errorMsg, agent: agentName, ts: Date.now() }));
    }
    await saveMessage("assistant", errorMsg, {}, "ellie-chat", ecUserId).catch(() => {});
  }
}
