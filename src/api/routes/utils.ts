/**
 * Shared utilities for per-domain HTTP route handlers.
 *
 * ELLIE-550: Extracted from handleHttpRequest() to per-route handlers.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { ApiResponse } from "../types.ts";

/** Promisify request body accumulation. */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (chunk: Buffer) => { buf += chunk.toString(); });
    req.on("end", () => resolve(buf));
  });
}

/** Build the mock ApiResponse adapter used by module handler functions. */
export function makeRes(res: ServerResponse): ApiResponse {
  return {
    status: (code: number) => ({
      json: (data: unknown) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      },
    }),
    json: (data: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    },
  };
}

/** Send a JSON error response. */
export function sendError(res: ServerResponse, code: number, message: string): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}
