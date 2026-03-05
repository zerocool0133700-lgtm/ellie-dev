/**
 * Briefing route handler — /api/briefing/*
 *
 * ELLIE-550: Extracted from handleHttpRequest() in http-routes.ts.
 * Business logic lives in ../briefing.ts.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Bot } from "grammy";
import type { ApiRequest } from "../types.ts";
import { log } from "../../logger.ts";
import { readBody, makeRes, sendError } from "./utils.ts";

const logger = log.child("briefing-route");

export async function handleBriefingRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  supabase: SupabaseClient | null,
  bot: Bot,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/briefing/")) return false;

  const mockRes = makeRes(res);

  try {
    if (url.pathname === "/api/briefing/generate" && req.method === "POST") {
      if (!supabase) {
        sendError(res, 500, "Supabase not configured");
        return true;
      }
      const body = await readBody(req);
      const data = body ? JSON.parse(body) : {};
      const { generateBriefingHandler } = await import("../briefing.ts");
      await generateBriefingHandler({ body: data }, mockRes, supabase, bot);
      return true;
    }

    if (url.pathname === "/api/briefing/latest" && req.method === "GET") {
      if (!supabase) {
        sendError(res, 500, "Supabase not configured");
        return true;
      }
      const { getLatestBriefing } = await import("../briefing.ts");
      await getLatestBriefing({} as ApiRequest, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/briefing/history" && req.method === "GET") {
      if (!supabase) {
        sendError(res, 500, "Supabase not configured");
        return true;
      }
      const queryParams: Record<string, string> = {};
      url.searchParams.forEach((v, k) => { queryParams[k] = v; });
      const { getBriefingHistory } = await import("../briefing.ts");
      await getBriefingHistory({ query: queryParams } as ApiRequest, mockRes, supabase);
      return true;
    }
  } catch (err) {
    logger.error("Briefing route error", err);
    sendError(res, 500, "Internal server error");
    return true;
  }

  return false;
}
