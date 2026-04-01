/**
 * OS Auth — Token Issuance & Verification
 *
 * Access tokens: RS256 JWTs, 15-min expiry, audience-scoped.
 * Refresh tokens: opaque random strings prefixed with "osrt_".
 */

import jwt from "jsonwebtoken"
import { randomBytes } from "crypto"
import type { OsAccessTokenPayload, OsAccount } from "./schema"

export const ACCESS_TOKEN_EXPIRY_SECONDS = 900 // 15 minutes
export const REFRESH_TOKEN_EXPIRY_DAYS = 30

interface SignAccessTokenInput {
  privateKey: string
  kid: string
  accountId: string
  email: string
  entityType: OsAccount['entity_type']
  audience: string
  memberships: OsAccessTokenPayload['memberships']
  expiresInSeconds?: number
}

/** Sign an RS256 access token. */
export async function signAccessToken(input: SignAccessTokenInput): Promise<string> {
  const payload = {
    sub: input.accountId,
    email: input.email,
    entity_type: input.entityType,
    memberships: input.memberships,
  }

  return jwt.sign(payload, input.privateKey, {
    algorithm: "RS256",
    expiresIn: input.expiresInSeconds ?? ACCESS_TOKEN_EXPIRY_SECONDS,
    audience: input.audience,
    issuer: "ellie-os",
    keyid: input.kid,
  })
}

/** Verify an access token against the public key and expected audience. Returns null if invalid. */
export function verifyAccessToken(
  token: string,
  publicKey: string,
  expectedAudience: string,
): OsAccessTokenPayload | null {
  try {
    const decoded = jwt.verify(token, publicKey, {
      algorithms: ["RS256"],
      audience: expectedAudience,
      issuer: "ellie-os",
    }) as OsAccessTokenPayload
    return decoded
  } catch {
    return null
  }
}

/** Generate an opaque refresh token. */
export function generateRefreshToken(): string {
  return "osrt_" + randomBytes(32).toString("hex")
}
