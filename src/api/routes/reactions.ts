/**
 * Reactions route handler — /api/reactions/*
 *
 * ELLIE-637: Emoji reactions on Ellie Chat messages.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "../../logger.ts";
import { readBody, sendError } from "./utils.ts";
import { makeReactionsDeps, toggleReaction, QUICK_REACTIONS } from "../reactions.ts";

const logger = log.child("reactions-route");

export async function handleReactionsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  supabase: SupabaseClient | null,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/reactions/")) return false;

  if (!supabase) {
    sendError(res, 500, "Supabase not configured");
    return true;
  }

  const deps = makeReactionsDeps(supabase);

  try {
    // POST /api/reactions/toggle — add or remove a reaction
    if (url.pathname === "/api/reactions/toggle" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const { message_id, emoji, user_id } = body;

      if (!message_id || !emoji) {
        sendError(res, 400, "message_id and emoji are required");
        return true;
      }

      const result = await toggleReaction(
        deps,
        message_id,
        emoji,
        user_id || "system-dashboard"
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return true;
    }

    // GET /api/reactions/:messageId — get reactions for a message
    const getMatch = url.pathname.match(/^\/api\/reactions\/([a-f0-9-]+)$/);
    if (getMatch && req.method === "GET") {
      const messageId = getMatch[1];
      const summary = await deps.getReactionSummary(messageId);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message_id: messageId, reactions: summary }));
      return true;
    }

    // GET /api/reactions/quick-list — return the quick reaction emoji list
    if (url.pathname === "/api/reactions/quick-list" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ emojis: QUICK_REACTIONS }));
      return true;
    }

    // POST /api/reactions/batch — get reactions for multiple messages
    if (url.pathname === "/api/reactions/batch" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const { message_ids } = body;

      if (!Array.isArray(message_ids)) {
        sendError(res, 400, "message_ids array required");
        return true;
      }

      const result = await deps.getReactionsForMessages(message_ids);
      const serialized: Record<string, unknown> = {};
      for (const [msgId, summary] of result) {
        serialized[msgId] = summary;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ reactions: serialized }));
      return true;
    }

    sendError(res, 404, "Not found");
    return true;
  } catch (err) {
    logger.error("Reactions route error", err);
    sendError(res, 500, "Internal error");
    return true;
  }
}
