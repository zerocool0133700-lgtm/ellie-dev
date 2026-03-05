/**
 * Calendar Intel route handler — /api/calendar-intel/*
 *
 * ELLIE-550: Extracted from handleHttpRequest() in http-routes.ts.
 * Business logic lives in ../calendar-intel.ts.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiRequest } from "../types.ts";
import { log } from "../../logger.ts";
import { readBody, makeRes, sendError } from "./utils.ts";

const logger = log.child("calendar-intel-route");

export async function handleCalendarIntelRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  supabase: SupabaseClient | null,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/calendar-intel/")) return false;

  if (!supabase) {
    sendError(res, 500, "Supabase not configured");
    return true;
  }

  const queryParams: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { queryParams[k] = v; });
  const mockRes = makeRes(res);

  try {
    if (url.pathname === "/api/calendar-intel/upcoming" && req.method === "GET") {
      const { getUpcoming } = await import("../calendar-intel.ts");
      await getUpcoming({ query: queryParams }, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/calendar-intel/conflicts" && req.method === "GET") {
      const { getConflicts } = await import("../calendar-intel.ts");
      await getConflicts({} as ApiRequest, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/calendar-intel/patterns" && req.method === "GET") {
      const { getPatterns } = await import("../calendar-intel.ts");
      await getPatterns({ query: queryParams }, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/calendar-intel/suggest-focus-blocks" && req.method === "GET") {
      const { getFocusBlocks } = await import("../calendar-intel.ts");
      getFocusBlocks({} as ApiRequest, mockRes);
      return true;
    }

    if (url.pathname === "/api/calendar-intel/insights" && req.method === "GET") {
      const { getInsights } = await import("../calendar-intel.ts");
      getInsights({} as ApiRequest, mockRes);
      return true;
    }

    if (url.pathname === "/api/calendar-intel/sync" && req.method === "POST") {
      const { syncCalendarIntel } = await import("../calendar-intel.ts");
      await syncCalendarIntel({} as ApiRequest, mockRes);
      return true;
    }

    if (url.pathname === "/api/calendar-intel/preferences" && req.method === "GET") {
      const { getPreferences } = await import("../calendar-intel.ts");
      await getPreferences({} as ApiRequest, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/calendar-intel/preferences" && req.method === "PUT") {
      const body = await readBody(req);
      const data = body ? JSON.parse(body) : {};
      const { updatePreferences } = await import("../calendar-intel.ts");
      await updatePreferences({ body: data }, mockRes, supabase);
      return true;
    }

    // /api/calendar-intel/event/:id and sub-actions
    const calIntelEventMatch = url.pathname.match(/^\/api\/calendar-intel\/event\/([0-9a-f-]+)(\/(\S+))?$/);
    if (calIntelEventMatch) {
      const eventId = calIntelEventMatch[1];
      const action = calIntelEventMatch[3];

      if (!action && req.method === "GET") {
        const { getEvent } = await import("../calendar-intel.ts");
        await getEvent({ params: { id: eventId } }, mockRes, supabase);
        return true;
      }

      if (action === "prep" && req.method === "POST") {
        const body = await readBody(req);
        const data = body ? JSON.parse(body) : {};
        const { updatePrep } = await import("../calendar-intel.ts");
        await updatePrep({ body: data, params: { id: eventId } }, mockRes, supabase);
        return true;
      }

      if (action === "mark-reviewed" && req.method === "POST") {
        const { markReviewed } = await import("../calendar-intel.ts");
        await markReviewed({ params: { id: eventId } }, mockRes, supabase);
        return true;
      }

      if (action === "generate-prep" && req.method === "POST") {
        const { generatePrep } = await import("../calendar-intel.ts");
        await generatePrep({ params: { id: eventId } }, mockRes, supabase);
        return true;
      }
    }
  } catch (err) {
    logger.error("Calendar-intel route error", err);
    sendError(res, 500, "Internal server error");
    return true;
  }

  return false;
}
