import { describe, test, expect } from "bun:test"
import { buildAuditEntry, AUDIT_EVENTS } from "../src/os-auth/audit"

describe("os-auth audit", () => {
  test("buildAuditEntry creates a valid entry with all fields", () => {
    const entry = buildAuditEntry({
      account_id: "acc-123",
      event_type: AUDIT_EVENTS.LOGIN,
      product: "life",
      ip_address: "192.168.1.1",
      user_agent: "Mozilla/5.0",
      metadata: { method: "email_password" },
    })
    expect(entry.account_id).toBe("acc-123")
    expect(entry.event_type).toBe("login")
    expect(entry.product).toBe("life")
    expect(entry.ip_address).toBe("192.168.1.1")
    expect(entry.metadata).toEqual({ method: "email_password" })
  })

  test("buildAuditEntry works with minimal fields", () => {
    const entry = buildAuditEntry({
      event_type: AUDIT_EVENTS.LOGIN_FAILED,
      ip_address: "10.0.0.1",
    })
    expect(entry.account_id).toBeNull()
    expect(entry.event_type).toBe("login_failed")
    expect(entry.product).toBeNull()
  })

  test("AUDIT_EVENTS contains all expected event types", () => {
    expect(AUDIT_EVENTS.LOGIN).toBe("login")
    expect(AUDIT_EVENTS.LOGOUT).toBe("logout")
    expect(AUDIT_EVENTS.TOKEN_REFRESH).toBe("token_refresh")
    expect(AUDIT_EVENTS.PASSWORD_CHANGE).toBe("password_change")
    expect(AUDIT_EVENTS.ACCOUNT_CREATE).toBe("account_create")
    expect(AUDIT_EVENTS.ACCOUNT_DELETE).toBe("account_delete")
    expect(AUDIT_EVENTS.LOGIN_FAILED).toBe("login_failed")
    expect(AUDIT_EVENTS.TOKEN_FAMILY_REVOKED).toBe("token_family_revoked")
  })
})
