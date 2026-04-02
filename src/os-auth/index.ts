/**
 * OS Auth — Route Dispatcher
 *
 * Wires all OS auth endpoints into the relay HTTP handler.
 * Called from http-routes.ts when pathname starts with /api/os-auth/
 * or is /.well-known/jwks.json.
 *
 * Endpoints:
 *   POST /api/os-auth/register  — create account
 *   POST /api/os-auth/login     — email/password login
 *   POST /api/os-auth/refresh   — rotate refresh token
 *   GET  /api/os-auth/me        — get current account from access token
 *   POST /api/os-auth/logout        — revoke session
 *   POST /api/os-auth/verify-email  — consume email verification token
 *   GET  /.well-known/jwks.json     — public key for token verification
 */

import type { Sql } from "postgres"
import type { ApiRequest, ApiResponse } from "../api/types.ts"
import { validateRegistrationInput, registerAccount, verifyAccountEmail } from "./registration"
import { validateLoginInput, loginWithPassword } from "./login"
import { consumeVerificationToken } from "./verification"
import { rotateRefreshToken, revokeAllAccountSessions, findSessionByRefreshToken } from "./sessions"
import { signAccessToken, verifyAccessToken } from "./tokens"
import { getSigningKeys, publicKeyToJwk, buildJwksResponse, _resetKeyCache, getAllActivePublicKeys, findPublicKeyByKid } from "./keys"
import { getAccountMemberships, buildMembershipMap } from "./memberships"
import { writeAudit, AUDIT_EVENTS } from "./audit"
import type { OsAccessTokenPayload } from "./schema"
import { checkRateLimit, checkRateLimitPg, checkRateLimitRedis, _resetRateLimits } from "./rate-limit"
import type Redis from "ioredis"
import { log } from "../logger.ts"

const logger = log.child("os-auth")

/** All product audiences that OS auth tokens may target. */
export const OS_AUTH_AUDIENCES = ["life", "learn"] as const

// ── Route Parsing (pure) ────────────────────────────────────

export interface OsAuthRouteMatch {
  handler: "register" | "login" | "refresh" | "me" | "logout" | "jwks" | "verify-email"
  method: string
}

export function parseOsAuthRoute(pathname: string, method: string): OsAuthRouteMatch | null {
  if (pathname === "/.well-known/jwks.json" && method === "GET") {
    return { handler: "jwks", method }
  }

  if (!pathname.startsWith("/api/os-auth/")) return null

  const endpoint = pathname.slice("/api/os-auth/".length)

  switch (endpoint) {
    case "register":
      return method === "POST" ? { handler: "register", method } : null
    case "login":
      return method === "POST" ? { handler: "login", method } : null
    case "refresh":
      return method === "POST" ? { handler: "refresh", method } : null
    case "me":
      return method === "GET" ? { handler: "me", method } : null
    case "logout":
      return method === "POST" ? { handler: "logout", method } : null
    case "verify-email":
      return method === "POST" ? { handler: "verify-email", method } : null
    default:
      return null
  }
}

// ── Route Handler ───────────────────────────────────────────

interface OsAuthDeps {
  sql: Sql
  redis?: Redis | null
  retrieveSecret: (keychainId: string, key: string) => Promise<string | null>
  storeSecret?: (keychainId: string, key: string, value: string) => Promise<void>
}

/**
 * Main route handler — call from http-routes.ts.
 * Returns true if the route was handled, false if not an os-auth route.
 * @param query — optional URLSearchParams forwarded from the incoming request URL
 */
export async function handleOsAuthRoute(
  req: ApiRequest & { headers?: Record<string, string> },
  res: ApiResponse,
  pathname: string,
  method: string,
  deps: OsAuthDeps,
  query?: URLSearchParams,
): Promise<boolean> {
  const match = parseOsAuthRoute(pathname, method)
  if (!match) return false

  const ipAddress = req.headers?.["x-forwarded-for"]?.split(",")[0]?.trim()
    || req.headers?.["x-real-ip"] || null
  const userAgent = req.headers?.["user-agent"] || null

  // Apply rate limiting to mutation endpoints before any DB work.
  // Try Redis first (fast, shared state), fall back to Postgres.
  if (match.handler === "register" || match.handler === "login" || match.handler === "refresh" || match.handler === "verify-email") {
    let rl: import("./rate-limit").RateLimitResult
    if (deps.redis) {
      try {
        rl = await checkRateLimitRedis(deps.redis, ipAddress, match.handler)
      } catch {
        // Redis unavailable — degrade to Postgres
        rl = await checkRateLimitPg(deps.sql, ipAddress, match.handler)
      }
    } else {
      rl = await checkRateLimitPg(deps.sql, ipAddress, match.handler)
    }
    if (!rl.allowed) {
      if (typeof res.setHeader === "function") {
        res.setHeader("Retry-After", String(rl.retryAfter))
      }
      res.status(429).json({
        error: "Too many requests",
        retryAfter: rl.retryAfter,
      })
      return true
    }
  }

  try {
    switch (match.handler) {
      case "jwks": {
        const jwks = await getAllActivePublicKeys(deps)
        res.json(buildJwksResponse(jwks))
        return true
      }

      case "register": {
        const validation = validateRegistrationInput(req.body ?? {})
        if (!validation.valid) {
          res.status(400).json({ error: validation.error })
          return true
        }
        const result = await registerAccount(deps.sql, {
          email: validation.email!,
          password: validation.password!,
          display_name: validation.display_name,
          entity_type: validation.entity_type,
        }, { ipAddress: ipAddress ?? undefined, userAgent: userAgent ?? undefined })

        if (!result.ok) {
          res.status(409).json({ error: result.error })
          return true
        }
        res.status(201).json({
          ok: true,
          account: {
            id: result.account!.id,
            email: result.account!.email,
            display_name: result.account!.display_name,
            status: result.account!.status,
          },
        })
        return true
      }

      case "login": {
        const validation = validateLoginInput(req.body ?? {})
        if (!validation.valid) {
          res.status(400).json({ error: validation.error })
          return true
        }
        const keys = await getSigningKeys(deps)
        const result = await loginWithPassword(deps.sql, {
          email: validation.email!,
          password: validation.password!,
          audience: validation.audience!,
        }, keys, { ipAddress: ipAddress ?? undefined, userAgent: userAgent ?? undefined })

        if (!result.ok) {
          res.status(401).json({ error: result.error })
          return true
        }
        res.json({
          ok: true,
          access_token: result.accessToken,
          refresh_token: result.refreshToken,
          account: result.account,
        })
        return true
      }

      case "refresh": {
        const refreshToken = typeof req.body?.refresh_token === "string" ? req.body.refresh_token : null
        if (!refreshToken) {
          res.status(400).json({ error: "refresh_token is required" })
          return true
        }

        const rotationResult = await rotateRefreshToken(deps.sql, refreshToken as string, {
          ipAddress: ipAddress ?? undefined,
          userAgent: userAgent ?? undefined,
        })

        if (rotationResult.replayDetected) {
          res.status(401).json({ error: "Session compromised — all sessions revoked" })
          return true
        }

        if (!rotationResult.session) {
          res.status(401).json({ error: "Invalid or expired refresh token" })
          return true
        }

        const newSession = rotationResult.session
        const keys = await getSigningKeys(deps)

        // Load account for token payload
        const [account] = await deps.sql<{ id: string; email: string; entity_type: string }[]>`
          SELECT id, email, entity_type FROM os_accounts WHERE id = ${newSession.account_id}
        `
        if (!account) {
          res.status(401).json({ error: "Account not found" })
          return true
        }

        // Load memberships
        const memberships = await getAccountMemberships(deps.sql, account.id)
        const membershipMap = buildMembershipMap(memberships)

        const audience = newSession.audience[0] || "life"
        const accessToken = await signAccessToken({
          privateKey: keys.privateKey,
          kid: keys.kid,
          accountId: account.id,
          email: account.email,
          entityType: account.entity_type as any,
          audience,
          memberships: membershipMap,
        })

        await writeAudit(deps.sql, {
          account_id: account.id,
          event_type: AUDIT_EVENTS.TOKEN_REFRESH,
          ip_address: ipAddress ?? undefined,
        })

        res.json({
          ok: true,
          access_token: accessToken,
          refresh_token: newSession.refresh_token,
        })
        return true
      }

      case "me": {
        const authHeader = req.headers?.authorization || ""
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
        if (!token) {
          res.status(401).json({ error: "Missing Authorization header" })
          return true
        }

        // Optional ?audience= query param — if provided, verify against that audience only
        const audienceParam = query?.get("audience") ?? null
        if (audienceParam !== null && !(OS_AUTH_AUDIENCES as readonly string[]).includes(audienceParam)) {
          res.status(400).json({ error: `Invalid audience. Must be one of: ${OS_AUTH_AUDIENCES.join(", ")}` })
          return true
        }

        const keys = await getSigningKeys(deps)
        // If audience param given, try only that audience; otherwise try all
        const audiencesToTry = audienceParam ? [audienceParam] : OS_AUTH_AUDIENCES
        let payload: OsAccessTokenPayload | null = null
        for (const aud of audiencesToTry) {
          payload = verifyAccessToken(token, keys.publicKey, aud)
          if (payload) break
        }

        if (!payload) {
          res.status(401).json({ error: "Invalid or expired token" })
          return true
        }

        const [account] = await deps.sql<{ id: string; email: string; display_name: string | null; entity_type: string; email_verified: boolean; status: string }[]>`
          SELECT id, email, display_name, entity_type, email_verified, status
          FROM os_accounts WHERE id = ${payload.sub}
        `
        if (!account) {
          res.status(401).json({ error: "Account not found" })
          return true
        }

        res.json({
          ok: true,
          account: {
            id: account.id,
            email: account.email,
            display_name: account.display_name,
            entity_type: account.entity_type,
            email_verified: account.email_verified,
            status: account.status,
          },
          memberships: payload.memberships,
        })
        return true
      }

      case "logout": {
        const refreshToken = typeof req.body?.refresh_token === "string" ? req.body.refresh_token : null
        const all = req.body?.all === true

        if (all) {
          // Need account ID from access token
          const authHeader = req.headers?.authorization || ""
          const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
          if (!token) {
            res.status(401).json({ error: "Missing Authorization header" })
            return true
          }
          const keys = await getSigningKeys(deps)
          let payload: OsAccessTokenPayload | null = null
          for (const aud of OS_AUTH_AUDIENCES) {
            payload = verifyAccessToken(token, keys.publicKey, aud)
            if (payload) break
          }
          if (!payload) {
            res.status(401).json({ error: "Invalid token" })
            return true
          }
          const count = await revokeAllAccountSessions(deps.sql, payload.sub)
          await writeAudit(deps.sql, {
            account_id: payload.sub,
            event_type: AUDIT_EVENTS.LOGOUT,
            ip_address: ipAddress ?? undefined,
            metadata: { scope: "all_sessions", revoked_count: count },
          })
          res.json({ ok: true, revoked: count })
        } else if (refreshToken) {
          const session = await findSessionByRefreshToken(deps.sql, refreshToken as string)
          if (session) {
            await deps.sql`UPDATE os_sessions SET revoked_at = now() WHERE id = ${session.id}`
            await writeAudit(deps.sql, {
              account_id: session.account_id,
              event_type: AUDIT_EVENTS.LOGOUT,
              ip_address: ipAddress ?? undefined,
              metadata: { scope: "single_session" },
            })
          }
          res.json({ ok: true })
        } else {
          res.status(400).json({ error: "refresh_token or all:true is required" })
        }
        return true
      }

      case "verify-email": {
        const token = typeof req.body?.token === "string" ? req.body.token : null
        if (!token) {
          res.status(400).json({ error: "token is required" })
          return true
        }

        const result = await consumeVerificationToken(deps.sql, token)
        if (!result.ok) {
          res.status(400).json({ error: result.error })
          return true
        }

        // Activate the account
        const activated = await verifyAccountEmail(deps.sql, result.accountId, {
          ipAddress: ipAddress ?? undefined,
        })

        if (!activated) {
          // Account was already active or in a non-pending state
          res.status(400).json({ error: "Account is not pending verification" })
          return true
        }

        res.json({ ok: true })
        return true
      }
    }
  } catch (err) {
    logger.error("OS auth route error", { handler: match.handler, error: err })
    res.status(500).json({ error: "Internal server error" })
    return true
  }

  return false
}

/** Re-export for testing */
export { _resetKeyCache, _resetRateLimits }
