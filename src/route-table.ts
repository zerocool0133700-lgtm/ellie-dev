/**
 * Route table — lightweight HTTP router for the relay server (ELLIE-550).
 *
 * Provides path matching, body parsing, and ApiRequest/ApiResponse adapters
 * so that route handlers can be tested in isolation without the 5,000-line
 * handleHttpRequest() monolith.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { ApiRequest, ApiResponse } from "./api/types.ts";
import type { RelayDeps } from "./relay-state.ts";

// ── Types ────────────────────────────────────────────────────

export interface RouteContext {
  url: URL;
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: Record<string, string>;
  rawBody: string;
  deps: RelayDeps;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void;

export interface Route {
  method: string;   // GET, POST, PATCH, DELETE, PUT, or ANY
  path: string;     // exact path, /prefix/*, or /path/:param
  handler: RouteHandler;
}

// ── Path matching ────────────────────────────────────────────

/**
 * Match a route path pattern against a URL pathname.
 * Returns extracted params on match, null on mismatch.
 *
 * Patterns:
 *   - Exact: "/health" matches "/health" only
 *   - Wildcard: "/forest/*" matches "/forest" and "/forest/anything/here"
 *   - Param: "/api/jobs/:id" matches "/api/jobs/123" → { id: "123" }
 *   - Param + suffix: "/api/jobs/:id/logs" → { id: "123" }
 */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  // Exact match (no params, no wildcard)
  if (!pattern.includes(":") && !pattern.endsWith("/*")) {
    return pattern === pathname ? {} : null;
  }

  // Wildcard: /prefix/*
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -2);
    if (pathname === prefix || pathname.startsWith(prefix + "/")) {
      return { "*": pathname.slice(prefix.length + 1) };
    }
    return null;
  }

  // Parameterized: /path/:param/more
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Find the first matching route for a given method + pathname.
 */
export function matchRoute(
  method: string,
  pathname: string,
  routes: Route[],
): { route: Route; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== "ANY" && route.method !== method) continue;
    const params = matchPath(route.path, pathname);
    if (params) return { route, params };
  }
  return null;
}

// ── Body parsing ─────────────────────────────────────────────

/**
 * Read the full request body as a string.
 */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/**
 * Parse a JSON string, returning {} on empty input.
 * Throws on invalid JSON.
 */
export function parseJson(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  return JSON.parse(raw);
}

// ── Response helpers ─────────────────────────────────────────

/**
 * Create an ApiResponse adapter from a raw ServerResponse.
 * Bridges the mock-Express pattern used by src/api/* handlers.
 */
export function createApiResponse(res: ServerResponse): ApiResponse {
  let responded = false;
  return {
    status: (code: number) => ({
      json: (data: unknown) => {
        if (responded) return;
        responded = true;
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      },
    }),
    json: (data: unknown) => {
      if (responded) return;
      responded = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    },
  };
}

/**
 * Send a JSON response.
 */
export function jsonReply(res: ServerResponse, data: unknown, status: number = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/**
 * Extract query params from a URL as a plain object.
 */
export function extractQuery(url: URL): Record<string, string> {
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { query[k] = v; });
  return query;
}

/**
 * Build an ApiRequest from a RouteContext.
 * Shorthand for the common pattern of { body, query, params }.
 */
export function buildApiRequest(ctx: RouteContext, extras?: Partial<ApiRequest>): ApiRequest {
  return {
    body: parseJson(ctx.rawBody),
    query: ctx.query,
    params: ctx.params,
    url: ctx.url.toString(),
    ...extras,
  };
}
