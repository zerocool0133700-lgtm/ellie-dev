/**
 * Slack Request Signature Verification — ELLIE-443
 *
 * Validates incoming Slack webhook requests using HMAC-SHA256.
 * See: https://api.slack.com/authentication/verifying-requests-from-slack
 */

import { createHmac, timingSafeEqual } from 'crypto'

const MAX_AGE_SECONDS = 300 // 5 minutes

/**
 * Verify a Slack webhook request signature.
 * Returns false if the signature is invalid or the timestamp is too old.
 */
export function verifySlackRequest(
  signingSecret: string,
  rawBody: string,
  timestamp: string,
  signature: string,
): boolean {
  if (!timestamp || !signature) return false

  // Reject requests older than 5 minutes (replay protection)
  const age = Math.abs(Date.now() / 1000 - Number(timestamp))
  if (age > MAX_AGE_SECONDS) return false

  const baseString = `v0:${timestamp}:${rawBody}`
  const expected = `v0=${createHmac('sha256', signingSecret).update(baseString).digest('hex')}`

  try {
    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'))
  } catch {
    return false
  }
}
