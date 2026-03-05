/**
 * Relationships Module route handler — /api/relationships/*
 *
 * ELLIE-550: Extracted from handleHttpRequest() in http-routes.ts.
 * Business logic lives in ../relationship.ts.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "../../logger.ts";
import { readBody, makeRes, sendError } from "./utils.ts";

const logger = log.child("relationships-route");

export async function handleRelationshipsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  supabase: SupabaseClient | null,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/relationships/")) return false;

  if (!supabase) {
    sendError(res, 500, "Supabase not configured");
    return true;
  }

  const queryParams: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { queryParams[k] = v; });
  const mockRes = makeRes(res);

  try {
    if (url.pathname === "/api/relationships/profiles" && req.method === "GET") {
      const { listProfiles } = await import("../relationship.ts");
      await listProfiles({ query: queryParams }, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/relationships/follow-ups" && req.method === "GET") {
      const { getFollowUps } = await import("../relationship.ts");
      await getFollowUps({}, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/relationships/health" && req.method === "GET") {
      const { getHealthBreakdown } = await import("../relationship.ts");
      await getHealthBreakdown({}, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/relationships/search" && req.method === "GET") {
      const { searchProfiles } = await import("../relationship.ts");
      await searchProfiles({ query: queryParams }, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/relationships/preferences" && req.method === "GET") {
      const { getPreferences } = await import("../relationship.ts");
      await getPreferences({}, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/relationships/preferences" && req.method === "PUT") {
      const body = await readBody(req);
      const data = body ? JSON.parse(body) : {};
      const { updatePreferences } = await import("../relationship.ts");
      await updatePreferences({ body: data }, mockRes, supabase);
      return true;
    }

    // /api/relationships/profile/:id and sub-actions
    const relProfileMatch = url.pathname.match(/^\/api\/relationships\/profile\/([0-9a-f-]+)(\/(\S+))?$/);
    if (relProfileMatch) {
      const profileId = relProfileMatch[1];
      const action = relProfileMatch[3];

      if (!action && req.method === "GET") {
        const { getProfile } = await import("../relationship.ts");
        await getProfile({ params: { id: profileId } }, mockRes, supabase);
        return true;
      }

      if (!action && req.method === "PUT") {
        const body = await readBody(req);
        const data = body ? JSON.parse(body) : {};
        const { updateProfile } = await import("../relationship.ts");
        await updateProfile({ params: { id: profileId }, body: data }, mockRes, supabase);
        return true;
      }

      if (action === "timeline" && req.method === "GET") {
        const { getTimeline } = await import("../relationship.ts");
        await getTimeline({ params: { id: profileId }, query: queryParams }, mockRes, supabase);
        return true;
      }

      if (action === "dismiss-follow-up" && req.method === "POST") {
        const { dismissFollowUp } = await import("../relationship.ts");
        await dismissFollowUp({ params: { id: profileId } }, mockRes, supabase);
        return true;
      }
    }
  } catch (err) {
    logger.error("Relationships route error", err);
    sendError(res, 500, "Internal server error");
    return true;
  }

  return false;
}
