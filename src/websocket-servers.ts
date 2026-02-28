/**
 * WebSocket servers — voice, extension, and Ellie Chat WebSocket setup.
 *
 * Extracted from relay.ts — ELLIE-184 Phase 3.
 */

import { appendFile } from "fs/promises";
import type { Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { log } from "./logger.ts";
import { EXTENSION_API_KEY } from "./relay-config.ts";
import {
  extensionClients, ellieChatClients, wsAppUserMap, ellieChatPhoneHistories,
  broadcastExtension, getRelayDeps,
} from "./relay-state.ts";
import { resetEllieChatIdleTimer } from "./relay-idle.ts";
import { handleVoiceConnection } from "./voice-pipeline.ts";
import {
  callClaude,
  session,
} from "./claude-cli.ts";
import { enqueueEllieChat } from "./message-queue.ts";
import {
  saveMessage,
  sendWithApprovalsEllieChat,
  ellieChatPendingActions,
} from "./message-sender.ts";
import { processMemoryIntents } from "./memory.ts";
import { handleEllieChatMessage } from "./ellie-chat-handler.ts";
import { extractPlaybookCommands, executePlaybookCommands, type PlaybookContext } from "./playbook.ts";
import { buildPrompt, getPlanningMode, setPlanningMode } from "./prompt-builder.ts";
import { ALLOWED_USER_ID, GCHAT_SPACE_NOTIFY } from "./relay-config.ts";
import {
  getAndAcknowledgeReadouts,
} from "./api/agent-queue.ts";
import {
  resolveToolApproval,
  clearSessionApprovals,
} from "./tool-approval.ts";

const logger = log.child("ws");

export function createWebSocketServers(httpServer: HttpServer): void {
  const { bot, supabase } = getRelayDeps();

const voiceWss = new WebSocketServer({ noServer: true });
voiceWss.on("connection", handleVoiceConnection);

// ============================================================
// CHROME EXTENSION LIVE FEED (WebSocket)
// ============================================================

const extensionWss = new WebSocketServer({ noServer: true });

// Route WebSocket upgrades to the correct WSS
httpServer.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url || "/", "http://localhost").pathname;
  if (pathname === "/media-stream") {
    voiceWss.handleUpgrade(req, socket, head, (ws) => {
      voiceWss.emit("connection", ws, req);
    });
  } else if (pathname === "/extension") {
    extensionWss.handleUpgrade(req, socket, head, (ws) => {
      extensionWss.emit("connection", ws, req);
    });
  } else if (pathname === "/ws/ellie-chat" || pathname === "/ws/la-comms") {
    ellieChatWss.handleUpgrade(req, socket, head, (ws) => {
      ellieChatWss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

extensionWss.on("connection", (ws: WebSocket) => {
  let authenticated = false;

  // 5-second auth timeout
  const authTimer = setTimeout(() => {
    if (!authenticated) {
      ws.close(4001, "Auth timeout");
    }
  }, 5000);

  ws.on("message", (data: Buffer | string) => {
    try {
      const msg = JSON.parse(data.toString());

      if (!authenticated) {
        if (msg.type === "auth" && msg.key === EXTENSION_API_KEY && EXTENSION_API_KEY) {
          authenticated = true;
          clearTimeout(authTimer);
          extensionClients.add(ws);
          ws.send(JSON.stringify({ type: "auth_ok", ts: Date.now() }));
          console.log(`[extension] Client authenticated (${extensionClients.size} connected)`);
        } else {
          ws.close(4003, "Invalid key");
        }
        return;
      }

      // Handle pong from client keepalive
      if (msg.type === "pong") return;

      // Save feed to log file
      if (msg.type === "save_feed" && msg.content) {
        const logPath = `${import.meta.dir}/../logs/ellie-feed-log`;
        const header = `\n--- Feed saved ${new Date().toISOString()} ---\n`;
        appendFile(logPath, header + msg.content + "\n")
          .then(() => console.log(`[extension] Feed saved to ${logPath}`))
          .catch((err) => logger.error("Failed to save feed", err));
        return;
      }
    } catch {
      // Ignore parse errors
    }
  });

  ws.on("close", () => {
    clearTimeout(authTimer);
    extensionClients.delete(ws);
    if (authenticated) {
      console.log(`[extension] Client disconnected (${extensionClients.size} connected)`);
    }
  });

  ws.on("error", () => {
    clearTimeout(authTimer);
    extensionClients.delete(ws);
  });
});

// Server-side ping every 30s to keep connections alive through nginx
setInterval(() => {
  const ping = JSON.stringify({ type: "ping", ts: Date.now() });
  for (const ws of extensionClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(ping);
    } else {
      extensionClients.delete(ws);
    }
  }
}, 30_000);

// ============================================================
// ELLIE CHAT — Dashboard WebSocket Chat
// ============================================================

const ellieChatWss = new WebSocketServer({ noServer: true });

/** Deliver pending readout queue items on ellie-chat connect (ELLIE-199). */
async function deliverPendingReadouts(ws: WebSocket): Promise<void> {
  try {
    const items = await getAndAcknowledgeReadouts();
    if (items.length === 0) return;

    // Format as a single assistant message summarizing all findings
    const lines = items.map((item: Record<string, unknown>) => {
      const ticket = item.work_item_id ? ` (${item.work_item_id})` : '';
      return `**${item.source}** ${item.category}${ticket}: ${item.content}`;
    });

    const summary = items.length === 1
      ? `${items[0].source} has a new finding for you:\n\n${lines[0]}`
      : `${items[0].source} has ${items.length} new findings:\n\n${lines.join('\n\n')}`;

    if (ws.readyState === WebSocket.OPEN) {
      // Extract memoryId from first item's related_refs for deduplication (ELLIE-199)
      const firstMemoryRef = (items[0]?.related_refs as Array<Record<string, unknown>> | undefined)?.find((ref) => ref.type === 'bridge')
      const memoryId = firstMemoryRef?.id || items[0]?.metadata?.bridge_memory_id

      ws.send(JSON.stringify({
        type: "response",
        text: summary,
        agent: "general",
        memoryId,
        ts: Date.now(),
      }));
    }

    console.log(`[ellie-chat] Delivered ${items.length} readout finding(s) on connect`);
  } catch (err) {
    logger.error("Readout delivery error", err);
  }
}

// WsAppUser, wsAppUserMap, ellieChatPhoneHistories imported from relay-state.ts (ELLIE-184)
// ellieChatPendingActions imported from ./message-sender.ts (ELLIE-207)

ellieChatWss.on("connection", (ws: WebSocket) => {
  let authenticated = false;

  const authTimer = setTimeout(() => {
    if (!authenticated) ws.close(4001, "Auth timeout");
  }, 5000);

  ws.on("message", (data: Buffer | string) => {
    try {
      const msg = JSON.parse(data.toString());

      if (!authenticated) {
        if (msg.type !== "auth") { ws.close(4003, "Expected auth"); return; }

        // Mode 1: Shared key (dashboard/extension) — maps to system-dashboard user (ELLIE-197)
        if (msg.key && msg.key === EXTENSION_API_KEY && EXTENSION_API_KEY) {
          authenticated = true;
          clearTimeout(authTimer);
          ellieChatClients.add(ws);
          wsAppUserMap.set(ws, { id: 'system-dashboard', name: 'Dashboard', email: null, onboarding_state: 'system', anonymous_id: null });
          ws.send(JSON.stringify({ type: "auth_ok", ts: Date.now() }));
          console.log(`[ellie-chat] Client authenticated via key (${ellieChatClients.size} connected)`);
          deliverPendingReadouts(ws).catch(() => {});
          return;
        }

        // Mode 2: Authenticated app user (session token)
        if (msg.token) {
          (async () => {
            try {
              const { getUserByToken } = await import("./api/app-auth.ts");
              const user = await getUserByToken(msg.token);
              if (!user) { ws.close(4003, "Invalid token"); return; }
              authenticated = true;
              clearTimeout(authTimer);
              ellieChatClients.add(ws);
              wsAppUserMap.set(ws, { id: user.id, name: user.name, email: user.email, onboarding_state: user.onboarding_state, anonymous_id: user.anonymous_id, token: msg.token });
              ws.send(JSON.stringify({ type: "auth_ok", ts: Date.now(), user: { id: user.id, name: user.name, onboarding_state: user.onboarding_state } }));
              console.log(`[ellie-chat] App user authenticated: ${user.name || user.id} (${ellieChatClients.size} connected)`);
              deliverPendingReadouts(ws).catch(() => {});
            } catch (err) {
              logger.error("Token auth error", err);
              ws.close(4003, "Auth error");
            }
          })();
          return;
        }

        // Mode 3: Anonymous app user (new visitor)
        if (msg.anonymous_id) {
          authenticated = true;
          clearTimeout(authTimer);
          ellieChatClients.add(ws);
          wsAppUserMap.set(ws, { id: '', name: null, email: null, onboarding_state: 'anonymous', anonymous_id: msg.anonymous_id });
          ws.send(JSON.stringify({ type: "auth_ok", ts: Date.now(), user: { id: null, name: null, onboarding_state: 'anonymous' } }));
          console.log(`[ellie-chat] Anonymous app user connected: ${msg.anonymous_id} (${ellieChatClients.size} connected)`);
          return;
        }

        ws.close(4003, "Invalid auth");
        return;
      }

      if (msg.type === "pong") return;

      // Session upgrade: anonymous → authenticated (ELLIE-176)
      if (msg.type === "session_upgrade" && msg.token) {
        (async () => {
          try {
            const { getUserByToken } = await import("./api/app-auth.ts");
            const user = await getUserByToken(msg.token);
            if (!user) {
              ws.send(JSON.stringify({ type: "error", text: "Invalid session token" }));
              return;
            }
            wsAppUserMap.set(ws, { id: user.id, name: user.name, email: user.email, onboarding_state: user.onboarding_state, anonymous_id: user.anonymous_id, token: msg.token });
            ws.send(JSON.stringify({ type: "session_upgraded", ts: Date.now(), user: { id: user.id, name: user.name, onboarding_state: user.onboarding_state } }));
            console.log(`[ellie-chat] Session upgraded: ${user.name || user.id}`);
          } catch (err) {
            logger.error("Session upgrade error", err);
          }
        })();
        return;
      }

      if (msg.type === "message" && (msg.text || msg.image)) {
        handleEllieChatMessage(ws, msg.text || "", !!msg.phone_mode, msg.image, msg.channel_id);
        return;
      }

      // New chat: close current conversation + agent sessions so next message starts fresh
      if (msg.type === "new_chat") {
        (async () => {
          try {
            const ncUser = wsAppUserMap.get(ws);
            const ncUserId = ncUser?.id || ncUser?.anonymous_id || undefined;
            if (supabase) {
              // Close conversations scoped to this user (ELLIE-197)
              // ELLIE-334: Scope by channel_id when provided — don't close other channels' conversations
              let convQuery = supabase
                .from("conversations")
                .update({ status: "closed" })
                .in("channel", ["ellie-chat", "la-comms"])
                .eq("status", "active");
              if (ncUserId) convQuery = convQuery.eq("user_id", ncUserId);
              if (msg.channel_id) convQuery = convQuery.eq("channel_id", msg.channel_id);
              await convQuery;

              let sessQuery = supabase
                .from("agent_sessions")
                .update({ state: "completed", completed_at: new Date().toISOString() })
                .in("channel", ["ellie-chat", "la-comms"])
                .eq("state", "active");
              if (ncUserId) sessQuery = sessQuery.eq("user_id", ncUserId);
              await sessQuery;
            }
            // Clear per-user phone history
            if (ncUserId) ellieChatPhoneHistories.delete(ncUserId);
            clearSessionApprovals(); // Reset tool approvals for new chat (ELLIE-213)
            ws.send(JSON.stringify({ type: "new_chat_ok", ts: Date.now() }));
            console.log(`[ellie-chat] New chat started for ${ncUser?.name || ncUserId || 'unknown'}`);
          } catch (err: unknown) {
            logger.error("New chat error", err);
          }
        })();
        return;
      }

      // Confirm/Deny response from frontend approve/deny buttons
      if (msg.type === "confirm_response" && msg.id && typeof msg.approved === "boolean") {
        const action = ellieChatPendingActions.get(msg.id);
        if (!action) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "response", text: "That confirmation has expired.", agent: "system", ts: Date.now() }));
          }
          return;
        }
        ellieChatPendingActions.delete(msg.id);

        const verb = msg.approved ? "Approved" : "Denied";
        const resumePrompt = msg.approved
          ? `The user APPROVED the following action: "${action.description}". Proceed with executing it now.`
          : `The user DENIED the following action: "${action.description}". Do NOT proceed. Acknowledge briefly.`;

        const confirmUser = wsAppUserMap.get(ws);
        const confirmUserId = confirmUser?.id || confirmUser?.anonymous_id || undefined;
        saveMessage("user", `[${verb} action: ${action.description}]`, {}, "ellie-chat", confirmUserId).catch(() => {});

        enqueueEllieChat(async () => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "typing", ts: Date.now() }));
          }
          const rawResponse = await callClaude(resumePrompt, { resume: true });
          const processed = await processMemoryIntents(supabase, rawResponse, action.agentName, "shared", undefined);
          const { cleanedText: pbClean, commands: pbCmds } = extractPlaybookCommands(processed);
          const { cleanedText, hadConfirmations } = sendWithApprovalsEllieChat(ws, pbClean, session.sessionId, action.agentName);

          await saveMessage("assistant", cleanedText, {}, "ellie-chat", confirmUserId);

          if (!hadConfirmations && ws.readyState === WebSocket.OPEN && cleanedText) {
            ws.send(JSON.stringify({
              type: "response",
              text: cleanedText,
              agent: action.agentName,
              ts: Date.now(),
            }));
          }

          if (pbCmds.length > 0) {
            const pbCtx: PlaybookContext = { bot, supabase, telegramUserId: ALLOWED_USER_ID, gchatSpaceName: GCHAT_SPACE_NOTIFY, channel: "ellie-chat", callClaudeFn: callClaude, buildPromptFn: buildPrompt };
            executePlaybookCommands(pbCmds, pbCtx).catch(err => logger.error("Playbook execution failed", err));
          }

          resetEllieChatIdleTimer();
        }, `[${verb} action]`);
        return;
      }

      // Tool approval response from frontend (ELLIE-213)
      if (msg.type === "tool_approval_response" && msg.id && typeof msg.approved === "boolean") {
        const resolved = resolveToolApproval(msg.id, msg.approved, msg.remember === true);
        if (!resolved) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "response", text: "That tool approval has already expired or been resolved. Ask Ellie to try again if needed.", agent: "system", ts: Date.now() }));
          }
        }
        return;
      }
    } catch {
      // Ignore parse errors
    }
  });

  ws.on("close", () => {
    clearTimeout(authTimer);
    ellieChatClients.delete(ws);
    if (authenticated) {
      const dcUser = wsAppUserMap.get(ws);
      // Clean up phone history if no other connections for this user (ELLIE-197)
      const dcUserId = dcUser?.id || dcUser?.anonymous_id;
      if (dcUserId) {
        let hasOtherConn = false;
        for (const client of ellieChatClients) {
          const cu = wsAppUserMap.get(client);
          if ((cu?.id || cu?.anonymous_id) === dcUserId) { hasOtherConn = true; break; }
        }
        if (!hasOtherConn) ellieChatPhoneHistories.delete(dcUserId);
      }
      console.log(`[ellie-chat] ${dcUser?.name || 'Client'} disconnected (${ellieChatClients.size} connected)`);
    }
  });

  ws.on("error", () => {
    clearTimeout(authTimer);
    ellieChatClients.delete(ws);
  });
});

// Server-side ping every 30s + token re-validation (ELLIE-196)
setInterval(async () => {
  const ping = JSON.stringify({ type: "ping", ts: Date.now() });
  for (const ws of ellieChatClients) {
    if (ws.readyState !== WebSocket.OPEN) {
      ellieChatClients.delete(ws);
      continue;
    }
    ws.send(ping);
    // Re-validate session tokens (skip shared-key and anonymous clients)
    const user = wsAppUserMap.get(ws);
    if (user?.token) {
      try {
        const { getUserByToken } = await import("./api/app-auth.ts");
        const current = await getUserByToken(user.token);
        if (!current) {
          console.log(`[ellie-chat] Token expired for ${user.name || user.id} — disconnecting`);
          ws.close(4002, "Session expired");
          ellieChatClients.delete(ws);
        }
      } catch { /* db hiccup — don't disconnect on transient errors */ }
    }
  }
}, 30_000);

// Phone mode history moved to per-user Map: ellieChatPhoneHistories (ELLIE-197)
}
