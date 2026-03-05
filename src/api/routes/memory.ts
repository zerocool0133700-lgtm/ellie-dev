/**
 * Memory Module route handler — /api/memory/*
 *
 * ELLIE-550: Extracted from handleHttpRequest() in http-routes.ts.
 * Business logic lives in ../memory-module.ts and ../memory-analytics.ts.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "../../logger.ts";
import { readBody, makeRes, sendError } from "./utils.ts";

const logger = log.child("memory-route");

// Supabase-exempt memory-analytics sub-paths (stats, timeline, by-agent).
const MEMORY_ANALYTICS_PATHS = ["stats", "timeline", "by-agent"];

export async function handleMemoryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  supabase: SupabaseClient | null,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/memory/")) return false;

  const subPath = url.pathname.replace("/api/memory/", "").split("/")[0];
  const needsSupabase = !MEMORY_ANALYTICS_PATHS.includes(subPath);

  if (needsSupabase && !supabase) {
    sendError(res, 500, "Supabase not configured");
    return true;
  }

  const queryParams: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { queryParams[k] = v; });
  const mockRes = makeRes(res);

  try {
    if (url.pathname === "/api/memory/facts" && req.method === "GET") {
      const { listFacts } = await import("../memory-module.ts");
      await listFacts({ query: queryParams }, mockRes, supabase!);
      return true;
    }

    if (url.pathname === "/api/memory/facts" && req.method === "POST") {
      const body = await readBody(req);
      const { createFact } = await import("../memory-module.ts");
      await createFact({ body: JSON.parse(body) }, mockRes, supabase!);
      return true;
    }

    if (url.pathname === "/api/memory/goals" && req.method === "GET") {
      const { listGoals } = await import("../memory-module.ts");
      await listGoals({ query: queryParams }, mockRes, supabase!);
      return true;
    }

    if (url.pathname === "/api/memory/conflicts" && req.method === "GET") {
      const { listConflicts } = await import("../memory-module.ts");
      await listConflicts({ query: queryParams }, mockRes, supabase!);
      return true;
    }

    if (url.pathname === "/api/memory/search" && req.method === "GET") {
      const { searchFacts } = await import("../memory-module.ts");
      await searchFacts({ query: queryParams }, mockRes, supabase!);
      return true;
    }

    if (url.pathname === "/api/memory/tags" && req.method === "GET") {
      const { listTags } = await import("../memory-module.ts");
      await listTags({}, mockRes, supabase!);
      return true;
    }

    if (url.pathname === "/api/memory/module-stats" && req.method === "GET") {
      const { getModuleStats } = await import("../memory-module.ts");
      await getModuleStats({}, mockRes);
      return true;
    }

    if (url.pathname === "/api/memory/health" && req.method === "GET") {
      const { getHealth } = await import("../memory-module.ts");
      await getHealth({}, mockRes);
      return true;
    }

    // /api/memory/facts/:id — PUT, DELETE
    const factsMatch = url.pathname.match(/^\/api\/memory\/facts\/([a-f0-9-]+)$/);
    if (factsMatch) {
      const factId = factsMatch[1];
      if (req.method === "PUT") {
        const body = await readBody(req);
        const { updateFact } = await import("../memory-module.ts");
        await updateFact({ body: JSON.parse(body), params: { id: factId } }, mockRes, supabase!);
        return true;
      }
      if (req.method === "DELETE") {
        const { deleteFact } = await import("../memory-module.ts");
        await deleteFact({ params: { id: factId } }, mockRes, supabase!);
        return true;
      }
    }

    // /api/memory/goals/:id/complete
    const goalCompleteMatch = url.pathname.match(/^\/api\/memory\/goals\/([a-f0-9-]+)\/complete$/);
    if (goalCompleteMatch && req.method === "POST") {
      const { completeGoal } = await import("../memory-module.ts");
      await completeGoal({ params: { id: goalCompleteMatch[1] } }, mockRes, supabase!);
      return true;
    }

    // /api/memory/conflicts/:id/resolve
    const conflictResolveMatch = url.pathname.match(/^\/api\/memory\/conflicts\/([a-f0-9-]+)\/resolve$/);
    if (conflictResolveMatch && req.method === "POST") {
      const body = await readBody(req);
      const { resolveConflict } = await import("../memory-module.ts");
      await resolveConflict({ body: JSON.parse(body), params: { id: conflictResolveMatch[1] } }, mockRes, supabase!);
      return true;
    }

    // Memory analytics catch-all (GET): stats, timeline, by-agent
    if (req.method === "GET") {
      const { handleGetStats, handleGetTimeline, handleGetByAgent } = await import("../memory-analytics.ts");
      const pathParts = url.pathname.replace("/api/memory/", "").split("/");
      const endpoint = pathParts[0];
      const param = pathParts[1] || null;
      const mockReq = { query: queryParams, params: { agent: param } };

      switch (endpoint) {
        case "stats":
          await handleGetStats(mockReq, mockRes);
          return true;
        case "timeline":
          await handleGetTimeline(mockReq, mockRes);
          return true;
        case "by-agent":
          if (!param) {
            sendError(res, 400, "Missing agent parameter");
            return true;
          }
          await handleGetByAgent(mockReq, mockRes);
          return true;
        default:
          sendError(res, 404, "Unknown memory endpoint");
          return true;
      }
    }
  } catch (err) {
    logger.error("Memory route error", err);
    sendError(res, 500, "Internal server error");
    return true;
  }

  return false;
}
