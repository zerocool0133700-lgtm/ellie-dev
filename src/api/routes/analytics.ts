/**
 * Analytics Module route handler — /api/analytics/*
 *
 * ELLIE-550: Extracted from handleHttpRequest() in http-routes.ts.
 * Business logic lives in ../analytics-module.ts.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { SupabaseClient } from "@supabase/supabase-js";
import { log } from "../../logger.ts";
import { makeRes, sendError } from "./utils.ts";

const logger = log.child("analytics-route");

export async function handleAnalyticsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  supabase: SupabaseClient | null,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/analytics/")) return false;

  if (!supabase) {
    sendError(res, 500, "Supabase not configured");
    return true;
  }

  const queryParams: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { queryParams[k] = v; });
  const mockRes = makeRes(res);

  try {
    if (url.pathname === "/api/analytics/summary" && req.method === "GET") {
      const { getSummary } = await import("../analytics-module.ts");
      await getSummary({ query: queryParams }, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/analytics/time-distribution" && req.method === "GET") {
      const { getTimeDistributionEndpoint } = await import("../analytics-module.ts");
      await getTimeDistributionEndpoint({ query: queryParams }, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/analytics/timeline" && req.method === "GET") {
      const { getTimeline } = await import("../analytics-module.ts");
      await getTimeline({ query: queryParams }, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/analytics/patterns" && req.method === "GET") {
      const { getPatternsEndpoint } = await import("../analytics-module.ts");
      await getPatternsEndpoint({ query: queryParams }, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/analytics/insights" && req.method === "GET") {
      const { getInsights } = await import("../analytics-module.ts");
      await getInsights({ query: queryParams }, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/analytics/focus-blocks" && req.method === "GET") {
      const { getFocusBlocksEndpoint } = await import("../analytics-module.ts");
      await getFocusBlocksEndpoint({ query: queryParams }, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/analytics/activity" && req.method === "GET") {
      const { getActivity } = await import("../analytics-module.ts");
      await getActivity({ query: queryParams }, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/analytics/module-stats" && req.method === "GET") {
      const { getModuleStats } = await import("../analytics-module.ts");
      await getModuleStats({}, mockRes);
      return true;
    }

    // /api/analytics/metrics/:date
    const metricsDateMatch = url.pathname.match(/^\/api\/analytics\/metrics\/(\d{4}-\d{2}-\d{2})$/);
    if (metricsDateMatch && req.method === "GET") {
      const { getMetrics } = await import("../analytics-module.ts");
      await getMetrics({ params: { date: metricsDateMatch[1] } }, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/analytics/compare" && req.method === "GET") {
      const { getCompare } = await import("../analytics-module.ts");
      await getCompare({ query: queryParams }, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/analytics/trends" && req.method === "GET") {
      const { getTrendsEndpoint } = await import("../analytics-module.ts");
      await getTrendsEndpoint({ query: queryParams }, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/analytics/anomalies" && req.method === "GET") {
      const { getAnomaliesEndpoint } = await import("../analytics-module.ts");
      await getAnomaliesEndpoint({ query: queryParams }, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/analytics/energy-curve" && req.method === "GET") {
      const { getEnergyCurveEndpoint } = await import("../analytics-module.ts");
      await getEnergyCurveEndpoint({ query: queryParams }, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/analytics/burnout-risk" && req.method === "GET") {
      const { getBurnoutRiskEndpoint } = await import("../analytics-module.ts");
      await getBurnoutRiskEndpoint({}, mockRes, supabase);
      return true;
    }
  } catch (err) {
    logger.error("Analytics route error", err);
    sendError(res, 500, "Internal server error");
    return true;
  }

  return false;
}
