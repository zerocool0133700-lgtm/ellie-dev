/**
 * OS Auth — Request Authentication Middleware
 *
 * Verifies OS auth access tokens on incoming requests.
 * Used by downstream products (Ellie Life, Ellie Learn) to
 * authenticate users against the OS auth system.
 *
 * ELLIE-1238
 */

import { verifyAccessToken } from "./tokens"
import { OS_AUTH_AUDIENCES } from "./index"
import type { OsAccessTokenPayload } from "./schema"

export interface AuthSuccess {
  ok: true
  payload: OsAccessTokenPayload
}

export interface AuthFailure {
  ok: false
  status: number
  error: string
}

export type AuthResult = AuthSuccess | AuthFailure

interface AuthenticateOptions {
  /** If set, only accept tokens targeting this specific audience. */
  audience?: string
}

/**
 * Authenticate an incoming request by verifying its OS auth Bearer token.
 *
 * @param headers — request headers (needs `authorization`)
 * @param publicKey — RS256 public key PEM for verification
 * @param options — optional audience constraint
 * @returns AuthResult with decoded payload on success, or status + error on failure
 */
export function authenticateOsRequest(
  headers: Record<string, string | undefined>,
  publicKey: string,
  options?: AuthenticateOptions,
): AuthResult {
  const authHeader = headers.authorization || ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null

  if (!token) {
    return { ok: false, status: 401, error: "Missing Authorization header" }
  }

  // If a specific audience is requested, only verify against that one
  if (options?.audience) {
    const payload = verifyAccessToken(token, publicKey, options.audience)
    if (payload) {
      return { ok: true, payload }
    }
    return { ok: false, status: 401, error: "Invalid or expired token" }
  }

  // Otherwise try all known audiences
  for (const aud of OS_AUTH_AUDIENCES) {
    const payload = verifyAccessToken(token, publicKey, aud)
    if (payload) {
      return { ok: true, payload }
    }
  }

  return { ok: false, status: 401, error: "Invalid or expired token" }
}
