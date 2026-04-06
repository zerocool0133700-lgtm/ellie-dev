import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  sendVerificationEmail,
  setEmailProvider,
  getEmailProvider,
  logEmailProvider,
  _resetEmailProvider,
  buildVerificationEmailHtml,
  buildVerificationEmailText,
  createSmtpEmailProvider,
  initEmailProvider,
} from "../src/os-auth/email"
import type { VerificationEmailParams, EmailProvider } from "../src/os-auth/email"

describe("OS Auth — Email Sender", () => {
  beforeEach(() => {
    _resetEmailProvider()
  })

  it("log provider returns sent:true and does not throw", async () => {
    const result = await sendVerificationEmail({
      to: "test@example.com",
      token: "osev_abc123",
      accountId: "acct-1",
    })
    expect(result.sent).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it("uses custom provider when set", async () => {
    const calls: VerificationEmailParams[] = []
    const customProvider: EmailProvider = async (params) => {
      calls.push(params)
      return { sent: true }
    }
    setEmailProvider(customProvider)

    await sendVerificationEmail({
      to: "user@example.com",
      token: "osev_xyz789",
      accountId: "acct-2",
      baseUrl: "https://custom.example.com",
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].to).toBe("user@example.com")
    expect(calls[0].token).toBe("osev_xyz789")
  })

  it("catches provider errors and returns sent:false", async () => {
    setEmailProvider(async () => {
      throw new Error("SMTP connection refused")
    })

    const result = await sendVerificationEmail({
      to: "fail@example.com",
      token: "osev_fail",
      accountId: "acct-3",
    })

    expect(result.sent).toBe(false)
    expect(result.error).toBe("SMTP connection refused")
  })

  it("getEmailProvider returns the active provider", () => {
    expect(getEmailProvider()).toBe(logEmailProvider)

    const custom: EmailProvider = async () => ({ sent: true })
    setEmailProvider(custom)
    expect(getEmailProvider()).toBe(custom)
  })

  it("_resetEmailProvider restores default log provider", () => {
    setEmailProvider(async () => ({ sent: false }))
    _resetEmailProvider()
    expect(getEmailProvider()).toBe(logEmailProvider)
  })
})

describe("OS Auth — Email Templates", () => {
  const verifyUrl = "https://life.ellie-labs.dev/verify-email?token=osev_test123"

  it("HTML template contains verify URL", () => {
    const html = buildVerificationEmailHtml(verifyUrl)
    expect(html).toContain(verifyUrl)
    expect(html).toContain("Verify your email")
    expect(html).toContain("24 hours")
    expect(html).toContain('href="' + verifyUrl + '"')
  })

  it("text template contains verify URL", () => {
    const text = buildVerificationEmailText(verifyUrl)
    expect(text).toContain(verifyUrl)
    expect(text).toContain("Verify your email")
    expect(text).toContain("24 hours")
  })

  it("HTML template is valid HTML structure", () => {
    const html = buildVerificationEmailHtml(verifyUrl)
    expect(html).toStartWith("<!DOCTYPE html>")
    expect(html).toContain("<html")
    expect(html).toContain("</html>")
  })
})

describe("OS Auth — SMTP Provider", () => {
  it("createSmtpEmailProvider returns a function", () => {
    const provider = createSmtpEmailProvider({
      host: "smtp.example.com",
      port: 587,
      auth: { user: "user", pass: "pass" },
      from: "noreply@example.com",
    })
    expect(typeof provider).toBe("function")
  })
})

describe("OS Auth — initEmailProvider", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    _resetEmailProvider()
    // Clear SMTP env vars
    delete process.env.SMTP_HOST
    delete process.env.SMTP_PORT
    delete process.env.SMTP_USER
    delete process.env.SMTP_PASS
    delete process.env.SMTP_FROM
    delete process.env.SMTP_SECURE
    delete process.env.SMTP_BASE_URL
  })

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv }
    _resetEmailProvider()
  })

  it("returns log provider when no SMTP vars are set", () => {
    const result = initEmailProvider()
    expect(result.provider).toBe("log")
    expect(getEmailProvider()).toBe(logEmailProvider)
  })

  it("returns log provider when SMTP config is incomplete", () => {
    process.env.SMTP_HOST = "smtp.example.com"
    // Missing port, user, pass, from
    const result = initEmailProvider()
    expect(result.provider).toBe("log")
  })

  it("configures SMTP provider when all vars are set", () => {
    process.env.SMTP_HOST = "smtp.example.com"
    process.env.SMTP_PORT = "587"
    process.env.SMTP_USER = "user"
    process.env.SMTP_PASS = "pass"
    process.env.SMTP_FROM = "noreply@example.com"

    const result = initEmailProvider()
    expect(result.provider).toBe("smtp")
    expect(result.from).toBe("noreply@example.com")
    expect(getEmailProvider()).not.toBe(logEmailProvider)
  })

  it("falls back to log when SMTP_PORT is not a number", () => {
    process.env.SMTP_HOST = "smtp.example.com"
    process.env.SMTP_PORT = "not-a-number"
    process.env.SMTP_USER = "user"
    process.env.SMTP_PASS = "pass"
    process.env.SMTP_FROM = "noreply@example.com"

    const result = initEmailProvider()
    expect(result.provider).toBe("log")
  })
})
