/**
 * Punch List route handler — /api/punch-list/*
 *
 * Collaborative daily working document between Dave and Ellie.
 * Business logic lives in ../punch-list.ts.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { ApiRequest } from "../types.ts";
import { log } from "../../logger.ts";
import { readBody, makeRes, sendError } from "./utils.ts";

const logger = log.child("punch-list-route");

export async function handlePunchListRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/punch-list")) return false;

  const mockRes = makeRes(res);

  try {
    // GET /api/punch-list
    if (url.pathname === "/api/punch-list" && req.method === "GET") {
      const { getPunchList } = await import("../punch-list.ts");
      await getPunchList({} as ApiRequest, mockRes);
      return true;
    }

    // PUT /api/punch-list
    if (url.pathname === "/api/punch-list" && req.method === "PUT") {
      const body = await readBody(req);
      const data = body ? JSON.parse(body) : {};
      const { updatePunchList } = await import("../punch-list.ts");
      await updatePunchList({ body: data } as ApiRequest, mockRes);
      return true;
    }

    // PATCH /api/punch-list/section
    if (url.pathname === "/api/punch-list/section" && req.method === "PATCH") {
      const body = await readBody(req);
      const data = body ? JSON.parse(body) : {};
      const { updatePunchListSection } = await import("../punch-list.ts");
      await updatePunchListSection({ body: data } as ApiRequest, mockRes);
      return true;
    }

    // POST /api/punch-list/new-day
    if (url.pathname === "/api/punch-list/new-day" && req.method === "POST") {
      const body = await readBody(req);
      const data = body ? JSON.parse(body) : {};
      const { newDayPunchList } = await import("../punch-list.ts");
      await newDayPunchList({ body: data } as ApiRequest, mockRes);
      return true;
    }
  } catch (err) {
    logger.error("Punch list route error", err);
    sendError(res, 500, "Internal server error");
    return true;
  }

  return false;
}
