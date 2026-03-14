/**
 * Emoji preferences route handler — /api/emoji-prefs/*
 *
 * ELLIE-639: Toggle contextual emoji in agent responses.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "../../logger.ts";
import { readBody, sendError } from "./utils.ts";
import {
  makeEmojiPrefsDeps,
  buildEmojiGuidance,
  type EmojiStyle,
} from "../../emoji-response.ts";
import { setEmojiGuidanceCache } from "../../prompt-builder.ts";

const logger = log.child("emoji-prefs-route");

export async function handleEmojiPrefsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  supabase: SupabaseClient | null,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/emoji-prefs")) return false;

  if (!supabase) {
    sendError(res, 500, "Supabase not configured");
    return true;
  }

  const deps = makeEmojiPrefsDeps(supabase);

  try {
    // GET /api/emoji-prefs — get current preferences
    if (url.pathname === "/api/emoji-prefs" && req.method === "GET") {
      const prefs = await deps.getPrefs();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(prefs));
      return true;
    }

    // PUT /api/emoji-prefs — update preferences
    if (url.pathname === "/api/emoji-prefs" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req));
      const updates: Partial<{ enabled: boolean; style: EmojiStyle }> = {};

      if (typeof body.enabled === "boolean") updates.enabled = body.enabled;
      if (body.style && ["none", "minimal", "balanced", "expressive"].includes(body.style)) {
        updates.style = body.style;
      }

      const merged = await deps.setPrefs(updates);

      // Update prompt builder cache
      const guidance = buildEmojiGuidance(merged);
      setEmojiGuidanceCache(guidance);

      logger.info("Emoji prefs updated", { enabled: merged.enabled, style: merged.style });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(merged));
      return true;
    }

    sendError(res, 404, "Not found");
    return true;
  } catch (err) {
    logger.error("Emoji prefs route error", err);
    sendError(res, 500, "Internal error");
    return true;
  }
}
