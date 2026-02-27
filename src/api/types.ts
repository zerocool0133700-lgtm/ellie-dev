/**
 * Shared types for relay API route handlers.
 *
 * The relay uses a lightweight mock-Express pattern: http-routes.ts creates
 * { body, query, params } request objects and { json, status } response objects,
 * then passes them to handler functions.  These interfaces capture that shape
 * so handlers can be typed without pulling in Express.
 *
 * ELLIE-243
 */

export interface ApiRequest {
  body?: Record<string, unknown>
  query?: Record<string, string>
  params?: Record<string, string | null>
  /** Bridge-specific: auth key from x-bridge-key header */
  bridgeKey?: string
  /** Raw request URL (used by agent-queue list to parse query params) */
  url?: string
}

export interface ApiResponse {
  json: (data: unknown) => void
  status: (code: number) => { json: (data: unknown) => void }
}
