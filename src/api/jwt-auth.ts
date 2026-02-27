/**
 * JWT auth — short-lived tokens for public API endpoint security.
 *
 * Signing secret loaded from the Hollow (no .env).
 * Tokens are scoped by audience (e.g. "tts", "stt") and expire in 1 hour.
 *
 * ELLIE-233
 */

import jwt from "jsonwebtoken";
import type { IncomingMessage } from "http";
import { retrieveSecret } from "../../../ellie-forest/src/hollow.ts";
import { log } from "../logger.ts";

const logger = log.child("jwt-auth");

const KEYCHAIN_ID = "568c0a6a-0c98-4784-87f3-d909139d8c35";
const TOKEN_EXPIRY = "1h";
const ISSUER = "ellie-relay";

// Cached signing secret — loaded from Hollow on first use
let _signingSecret: string | null = null;

async function getSigningSecret(): Promise<string> {
  if (_signingSecret) return _signingSecret;
  const secret = await retrieveSecret(KEYCHAIN_ID, "jwt_signing_secret");
  if (!secret) throw new Error("JWT signing secret not found in Hollow");
  _signingSecret = secret;
  logger.info("JWT signing secret loaded from Hollow");
  return secret;
}

// ── Token payload ────────────────────────────────────────────

export interface JwtPayload {
  sub: string;       // subject (e.g. "dashboard", user ID)
  aud: string[];     // audience scopes (e.g. ["tts", "stt"])
  iss: string;       // issuer
  iat: number;       // issued at
  exp: number;       // expiry
}

// ── Sign ─────────────────────────────────────────────────────

export async function signToken(
  subject: string,
  scopes: string[],
): Promise<string> {
  const secret = await getSigningSecret();
  return jwt.sign(
    { sub: subject, aud: scopes },
    secret,
    { expiresIn: TOKEN_EXPIRY, issuer: ISSUER },
  );
}

// ── Verify ───────────────────────────────────────────────────

/**
 * Verify a JWT and check that it has the required scope.
 * Returns the decoded payload on success, null on failure.
 */
export async function verifyToken(
  token: string,
  requiredScope: string,
): Promise<JwtPayload | null> {
  try {
    const secret = await getSigningSecret();
    const decoded = jwt.verify(token, secret, {
      issuer: ISSUER,
      audience: requiredScope,
    }) as JwtPayload;
    return decoded;
  } catch (err: any) {
    if (err.name !== "TokenExpiredError") {
      logger.warn("JWT verification failed", { error: err.message });
    }
    return null;
  }
}

// ── Request helpers ──────────────────────────────────────────

/** Extract Bearer token from request Authorization header. */
export function extractBearer(req: IncomingMessage): string | null {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

/**
 * Authenticate a request via JWT or legacy x-api-key.
 * Returns the decoded JWT payload, or null if unauthorized.
 *
 * Accepts either:
 *   - Authorization: Bearer <jwt>  (preferred — scoped, expiring)
 *   - x-api-key: <extension-api-key>  (legacy — for backwards compatibility)
 */
export async function authenticateRequest(
  req: IncomingMessage,
  requiredScope: string,
  legacyApiKey?: string,
): Promise<JwtPayload | null> {
  // Try JWT first
  const bearer = extractBearer(req);
  if (bearer) {
    return verifyToken(bearer, requiredScope);
  }

  // Fall back to legacy x-api-key
  if (legacyApiKey) {
    const apiKey = req.headers["x-api-key"] as string;
    if (apiKey && apiKey === legacyApiKey) {
      // Return a synthetic payload for legacy callers
      return {
        sub: "legacy-api-key",
        aud: [requiredScope],
        iss: ISSUER,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
    }
  }

  return null;
}
