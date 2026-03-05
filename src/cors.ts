/**
 * CORS utility — origin whitelist + preflight handling (ELLIE-547).
 *
 * Replaces the wildcard Access-Control-Allow-Origin: * on /api/skills/*
 * with an explicit per-request origin check against a configurable whitelist.
 */

import type { IncomingMessage, ServerResponse } from "http";

// ── Whitelist ────────────────────────────────────────────────────────────────

const DEFAULT_ALLOWED_ORIGINS = [
  "https://dashboard.ellie-labs.dev",
  "https://ellie.ellie-labs.dev",
  "http://localhost:3000",
  "http://localhost:3002",
];

/**
 * Set of allowed origins, configurable via CORS_ORIGINS env var
 * (comma-separated list overrides the defaults entirely).
 */
export const CORS_ALLOWED_ORIGINS: Set<string> = new Set(
  process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(",").map(o => o.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_ORIGINS,
);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns the origin string if it's in the whitelist, or null if not allowed.
 * An absent/undefined origin is always rejected.
 */
export function getAllowedOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  return CORS_ALLOWED_ORIGINS.has(origin) ? origin : null;
}

/**
 * Returns an Access-Control-Allow-Origin header object if the origin is
 * whitelisted, or an empty object if not. Safe to spread into writeHead.
 */
export function corsHeader(
  origin: string | undefined,
): Record<string, string> {
  const allowed = getAllowedOrigin(origin);
  return allowed ? { "Access-Control-Allow-Origin": allowed } : {};
}

// ── Preflight ────────────────────────────────────────────────────────────────

const PREFLIGHT_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
  "Access-Control-Max-Age": "86400",
};

/**
 * Handles an OPTIONS preflight request.
 * - Returns true (request handled) for any OPTIONS request.
 * - Allowed origin → 204 with full CORS preflight headers.
 * - Unknown / missing origin → 403.
 *
 * Call this near the top of handleHttpRequest before any auth checks.
 */
export function handlePreflight(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (req.method !== "OPTIONS") return false;

  const origin = req.headers.origin as string | undefined;
  const allowed = getAllowedOrigin(origin);

  if (!allowed) {
    res.writeHead(403);
    res.end();
    return true;
  }

  res.writeHead(204, {
    "Access-Control-Allow-Origin": allowed,
    ...PREFLIGHT_HEADERS,
  });
  res.end();
  return true;
}
