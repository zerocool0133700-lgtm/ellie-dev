/**
 * Comms Module route handler — /api/comms/*
 *
 * ELLIE-550: Extracted from handleHttpRequest() in http-routes.ts.
 * Business logic lives in ../comms.ts.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiRequest } from "../types.ts";
import { log } from "../../logger.ts";
import { readBody, makeRes, sendError } from "./utils.ts";

const logger = log.child("comms-route");

export async function handleCommsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  supabase: SupabaseClient | null,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/comms/")) return false;

  if (!supabase) {
    sendError(res, 500, "Supabase not configured");
    return true;
  }

  const queryParams: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { queryParams[k] = v; });
  const mockRes = makeRes(res);

  try {
    if (url.pathname === "/api/comms/threads" && req.method === "GET") {
      const { listThreads } = await import("../comms.ts");
      await listThreads({ query: queryParams }, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/comms/stale" && req.method === "GET") {
      const { getStale } = await import("../comms.ts");
      await getStale({} as ApiRequest, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/comms/preferences" && req.method === "GET") {
      const { getPreferences } = await import("../comms.ts");
      await getPreferences({} as ApiRequest, mockRes, supabase);
      return true;
    }

    if (url.pathname === "/api/comms/preferences" && req.method === "PUT") {
      const body = await readBody(req);
      const data = body ? JSON.parse(body) : {};
      const { updatePreferences } = await import("../comms.ts");
      await updatePreferences({ body: data }, mockRes, supabase);
      return true;
    }

    // /api/comms/threads/:id, /api/comms/threads/:id/snooze, /api/comms/threads/:id/resolve
    const commsThreadMatch = url.pathname.match(/^\/api\/comms\/threads\/([0-9a-f-]+)(\/(\w+))?$/);
    if (commsThreadMatch) {
      const threadId = commsThreadMatch[1];
      const action = commsThreadMatch[3];

      if (!action && req.method === "GET") {
        const { getThread } = await import("../comms.ts");
        await getThread({ params: { id: threadId } }, mockRes, supabase);
        return true;
      }

      if ((action === "snooze" || action === "resolve") && req.method === "POST") {
        const body = await readBody(req);
        const data = body ? JSON.parse(body) : {};
        const mod = await import("../comms.ts");
        const handler = action === "snooze" ? mod.snoozeThread : mod.resolveThread;
        await handler({ body: data, params: { id: threadId } }, mockRes, supabase);
        return true;
      }
    }
  } catch (err) {
    logger.error("Comms route error", err);
    sendError(res, 500, "Internal server error");
    return true;
  }

  return false;
}
