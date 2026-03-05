/**
 * Google Chat Webhook Signature Verification — ELLIE-553
 *
 * Google Chat Apps send an Authorization: Bearer <token> header on every
 * inbound request. Configure GOOGLE_CHAT_VERIFICATION_TOKEN in env with
 * the token you set in the Google Cloud Console (or the bearer token
 * Google issues for your project).
 *
 * See: https://developers.google.com/chat/how-tos/bots-develop#verifying_bot_authenticity
 */

import { timingSafeEqual } from "crypto";

/** Result of verifying a Google Chat request. */
export type GChatVerifyResult = "allowed" | "unauthorized" | "unconfigured";

/**
 * Verify a Google Chat webhook request.
 *
 * - "allowed"       — Authorization header matches the configured token.
 * - "unauthorized"  — Token is configured but header is missing or wrong.
 * - "unconfigured"  — GOOGLE_CHAT_VERIFICATION_TOKEN is not set; caller
 *                     should warn and decide whether to allow.
 *
 * Uses constant-time comparison to prevent timing attacks.
 */
export function verifyGoogleChatRequest(
  authHeader: string | undefined,
  verificationToken: string | undefined,
): GChatVerifyResult {
  if (!verificationToken) return "unconfigured";
  if (!authHeader) return "unauthorized";

  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return "unauthorized";

  const token = authHeader.slice(prefix.length);
  if (!token) return "unauthorized";

  try {
    const expected = Buffer.from(verificationToken, "utf8");
    const actual = Buffer.from(token, "utf8");
    if (expected.length !== actual.length) return "unauthorized";
    return timingSafeEqual(expected, actual) ? "allowed" : "unauthorized";
  } catch {
    return "unauthorized";
  }
}
