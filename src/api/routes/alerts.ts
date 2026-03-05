/**
 * Alerts Module route handler — /api/alerts/*
 *
 * ELLIE-550: Extracted from handleHttpRequest() in http-routes.ts.
 * Business logic lives in ../alerts.ts.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiRequest } from "../types.ts";
import { log } from "../../logger.ts";
import { readBody, makeRes, sendError } from "./utils.ts";

const logger = log.child("alerts-route");

export async function handleAlertsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  supabase: SupabaseClient | null,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/alerts/")) return false;

  if (!supabase) {
    sendError(res, 500, "Supabase not configured");
    return true;
  }

  const queryParams: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { queryParams[k] = v; });
  const mockRes = makeRes(res);

  try {
    if (url.pathname === "/api/alerts/rules" && req.method === "GET") {
      const { listRules } = await import("../alerts.ts");
      await listRules({} as ApiRequest, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/alerts/rules" && req.method === "POST") {
      const body = await readBody(req);
      const data = body ? JSON.parse(body) : {};
      const { createRule } = await import("../alerts.ts");
      await createRule({ body: data }, mockRes, supabase);
      return true;
    }

    // PATCH/DELETE /api/alerts/rules/:id
    const alertRuleMatch = url.pathname.match(/^\/api\/alerts\/rules\/([0-9a-f-]+)$/);
    if (alertRuleMatch) {
      const ruleId = alertRuleMatch[1];
      if (req.method === "DELETE") {
        const { deleteRule } = await import("../alerts.ts");
        await deleteRule({ params: { id: ruleId } }, mockRes, supabase);
        return true;
      }
      if (req.method === "PATCH") {
        const body = await readBody(req);
        const data = body ? JSON.parse(body) : {};
        const { updateRule } = await import("../alerts.ts");
        await updateRule({ body: data, params: { id: ruleId } }, mockRes, supabase);
        return true;
      }
    }

    if (url.pathname === "/api/alerts/recent" && req.method === "GET") {
      const { getRecentAlerts } = await import("../alerts.ts");
      await getRecentAlerts({ query: queryParams }, mockRes, supabase);
      return true;
    }

    // POST /api/alerts/acknowledge/:id
    const alertAckMatch = url.pathname.match(/^\/api\/alerts\/acknowledge\/([0-9a-f-]+)$/);
    if (alertAckMatch && req.method === "POST") {
      const body = await readBody(req);
      const data = body ? JSON.parse(body) : {};
      const { acknowledgeAlert } = await import("../alerts.ts");
      await acknowledgeAlert({ body: data, params: { id: alertAckMatch[1] } }, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/alerts/preferences" && req.method === "GET") {
      const { getPreferences } = await import("../alerts.ts");
      await getPreferences({} as ApiRequest, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/alerts/preferences" && req.method === "PUT") {
      const body = await readBody(req);
      const data = body ? JSON.parse(body) : {};
      const { updatePreferences } = await import("../alerts.ts");
      await updatePreferences({ body: data }, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/alerts/test" && req.method === "POST") {
      const body = await readBody(req);
      const data = body ? JSON.parse(body) : {};
      const { testRule } = await import("../alerts.ts");
      await testRule({ body: data }, mockRes, supabase);
      return true;
    }
  } catch (err) {
    logger.error("Alerts route error", err);
    sendError(res, 500, "Internal server error");
    return true;
  }

  return false;
}
