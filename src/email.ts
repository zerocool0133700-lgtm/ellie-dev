/**
 * Email — Resend integration (ELLIE-176)
 *
 * Sends verification codes for app onboarding.
 * Uses native fetch() — no npm dependency.
 */

import { log } from "./logger.ts";

const logger = log.child("email");

const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const FROM_EMAIL = process.env.FROM_EMAIL || 'Ellie <ellie@ellie-labs.dev>'

export async function sendVerificationCode(email: string, code: string): Promise<boolean> {
  if (!RESEND_API_KEY) {
    logger.error('RESEND_API_KEY not set')
    return false
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [email],
        subject: `${code} — Your Ellie verification code`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 400px; margin: 0 auto; padding: 40px 20px;">
            <p style="color: #2d2a26; font-size: 16px; line-height: 1.6; margin: 0 0 24px;">
              Hi there — here's your verification code:
            </p>
            <div style="background: #f8f5f0; border-radius: 12px; padding: 20px; text-align: center; margin: 0 0 24px;">
              <span style="font-size: 32px; font-weight: 600; letter-spacing: 6px; color: #2d2a26;">${code}</span>
            </div>
            <p style="color: #8a8178; font-size: 14px; line-height: 1.5; margin: 0;">
              Type this code in our chat to verify your account. It expires in 10 minutes.
            </p>
          </div>
        `,
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      logger.error('Resend error', { status: res.status, body })
      return false
    }

    console.log(`[email] Verification code sent to ${email}`)
    return true
  } catch (err) {
    logger.error('Failed to send', err)
    return false
  }
}
