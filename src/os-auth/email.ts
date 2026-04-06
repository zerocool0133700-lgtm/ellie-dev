/**
 * OS Auth — Verification Email Sender
 *
 * Pluggable email sending for verification tokens.
 * Built-in providers:
 *   - logEmailProvider  — writes the verify URL to the app log (dev/Phase 0)
 *   - smtpEmailProvider — sends via SMTP (production)
 *
 * At startup, call `initEmailProvider()` to auto-detect and configure
 * the best available provider from environment variables.
 */

import { log } from "../logger.ts"
import { createTransport, type Transporter } from "nodemailer"

const logger = log.child("os-auth-email")

// ── Provider Interface ─────────────────────────────────────

export interface VerificationEmailParams {
  to: string
  token: string
  accountId: string
  baseUrl?: string
}

export type EmailProvider = (params: VerificationEmailParams) => Promise<{ sent: boolean; error?: string }>

// ── HTML Template ──────────────────────────────────────────

export function buildVerificationEmailHtml(verifyUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;padding:40px;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <tr><td style="text-align:center;padding-bottom:24px;">
          <h1 style="margin:0;font-size:24px;color:#18181b;">Verify your email</h1>
        </td></tr>
        <tr><td style="font-size:16px;line-height:24px;color:#3f3f46;padding-bottom:24px;">
          Click the button below to verify your email address and activate your account.
        </td></tr>
        <tr><td align="center" style="padding-bottom:24px;">
          <a href="${verifyUrl}" style="display:inline-block;padding:12px 32px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:6px;font-size:16px;font-weight:600;">
            Verify Email
          </a>
        </td></tr>
        <tr><td style="font-size:13px;line-height:20px;color:#71717a;padding-bottom:16px;">
          If the button doesn't work, copy and paste this link into your browser:
        </td></tr>
        <tr><td style="font-size:13px;line-height:20px;color:#2563eb;word-break:break-all;padding-bottom:24px;">
          ${verifyUrl}
        </td></tr>
        <tr><td style="font-size:12px;color:#a1a1aa;border-top:1px solid #e4e4e7;padding-top:16px;">
          This link expires in 24 hours. If you didn't create an account, you can ignore this email.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}

export function buildVerificationEmailText(verifyUrl: string): string {
  return `Verify your email

Click the link below to verify your email address and activate your account:

${verifyUrl}

This link expires in 24 hours. If you didn't create an account, you can ignore this email.`
}

// ── Built-in Providers ─────────────────────────────────────

/**
 * Log provider — writes the verification URL to the application log.
 * Used in development and Phase 0 where no email service is configured.
 */
export const logEmailProvider: EmailProvider = async (params) => {
  const verifyUrl = `${params.baseUrl ?? "https://life.ellie-labs.dev"}/verify-email?token=${params.token}`
  logger.info("Verification email (log provider)", {
    to: params.to,
    accountId: params.accountId,
    verifyUrl,
  })
  return { sent: true }
}

/**
 * SMTP provider — sends verification emails via SMTP using nodemailer.
 * Works with any SMTP server: SendGrid, Postmark, SES, Mailgun, self-hosted.
 */
export function createSmtpEmailProvider(config: SmtpConfig): EmailProvider {
  const transporter = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure ?? config.port === 465,
    auth: config.auth,
  })

  return async (params) => {
    const verifyUrl = `${params.baseUrl ?? config.baseUrl ?? "https://life.ellie-labs.dev"}/verify-email?token=${params.token}`

    const result = await transporter.sendMail({
      from: config.from,
      to: params.to,
      subject: "Verify your email — Ellie OS",
      text: buildVerificationEmailText(verifyUrl),
      html: buildVerificationEmailHtml(verifyUrl),
    })

    logger.info("Verification email sent via SMTP", {
      to: params.to,
      accountId: params.accountId,
      messageId: result.messageId,
    })

    return { sent: true }
  }
}

export interface SmtpConfig {
  host: string
  port: number
  secure?: boolean
  auth: { user: string; pass: string }
  from: string
  baseUrl?: string
}

// ── Active Provider ────────────────────────────────────────

let _activeProvider: EmailProvider = logEmailProvider

/** Set the active email provider. Call at startup if a real provider is configured. */
export function setEmailProvider(provider: EmailProvider): void {
  _activeProvider = provider
}

/** Get the active email provider. */
export function getEmailProvider(): EmailProvider {
  return _activeProvider
}

/** Send a verification email using the active provider. Never throws — returns result. */
export async function sendVerificationEmail(params: VerificationEmailParams): Promise<{ sent: boolean; error?: string }> {
  try {
    return await _activeProvider(params)
  } catch (err) {
    logger.error("Failed to send verification email", { error: err, to: params.to })
    return { sent: false, error: err instanceof Error ? err.message : "Unknown error" }
  }
}

// ── Auto-Init ──────────────────────────────────────────────

/**
 * Detect and configure the email provider from environment variables.
 * Call once at startup. Falls back to log provider if SMTP is not configured.
 *
 * Required env vars for SMTP:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 *
 * Optional:
 *   SMTP_SECURE (default: true for port 465, false otherwise)
 *   SMTP_BASE_URL (override the verify link base URL)
 */
export function initEmailProvider(): { provider: "smtp" | "log"; from?: string } {
  const host = process.env.SMTP_HOST
  const port = process.env.SMTP_PORT
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS
  const from = process.env.SMTP_FROM

  if (host && port && user && pass && from) {
    const portNum = parseInt(port, 10)
    if (isNaN(portNum)) {
      logger.warn("SMTP_PORT is not a valid number, falling back to log provider")
      return { provider: "log" }
    }

    const secure = process.env.SMTP_SECURE
      ? process.env.SMTP_SECURE === "true"
      : portNum === 465

    const provider = createSmtpEmailProvider({
      host,
      port: portNum,
      secure,
      auth: { user, pass },
      from,
      baseUrl: process.env.SMTP_BASE_URL,
    })

    setEmailProvider(provider)
    logger.info("Email provider initialized: SMTP", { host, port: portNum, from })
    return { provider: "smtp", from }
  }

  logger.info("No SMTP config found — using log email provider")
  return { provider: "log" }
}

/** Reset to default provider — for testing only. */
export function _resetEmailProvider(): void {
  _activeProvider = logEmailProvider
}
