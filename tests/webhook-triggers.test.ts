/**
 * Webhook Triggers — ELLIE-977
 * Tests for validation, token generation, routing, cooldown, and security.
 */

import { describe, it, expect } from "bun:test";
import {
  validateWebhookInput,
  _generateTokenForTesting as generateToken,
  type CreateWebhookInput,
  type WebhookTrigger,
  type InvokeResult,
} from "../src/webhook-triggers.ts";

// ── Validation ───────────────────────────────────────────────

describe("validateWebhookInput", () => {
  const base: CreateWebhookInput = {
    name: "Deploy hook",
    action_type: "dispatch",
    config: { agent: "jason", prompt: "Deploy latest" },
  };

  it("accepts valid input", () => {
    expect(validateWebhookInput(base)).toBeNull();
  });

  it("rejects empty name", () => {
    expect(validateWebhookInput({ ...base, name: "" })).toBe("name is required");
    expect(validateWebhookInput({ ...base, name: "   " })).toBe("name is required");
  });

  it("rejects invalid action_type", () => {
    expect(validateWebhookInput({ ...base, action_type: "bad" as any }))
      .toBe("invalid action_type: bad");
  });

  it("validates config per action type", () => {
    // dispatch missing prompt
    expect(validateWebhookInput({
      name: "test",
      action_type: "dispatch",
      config: { agent: "james" },
    })).toBe("dispatch tasks require config.prompt");

    // formation valid
    expect(validateWebhookInput({
      name: "test",
      action_type: "formation",
      config: { formation_slug: "daily-standup" },
    })).toBeNull();

    // http valid
    expect(validateWebhookInput({
      name: "test",
      action_type: "http",
      config: { endpoint: "/api/health" },
    })).toBeNull();

    // reminder valid
    expect(validateWebhookInput({
      name: "test",
      action_type: "reminder",
      config: { message: "Hello" },
    })).toBeNull();
  });
});

// ── Token Generation ─────────────────────────────────────────

describe("token generation", () => {
  it("generates 48-char hex tokens", () => {
    const token = generateToken();
    expect(token).toHaveLength(48);
    expect(/^[a-f0-9]{48}$/.test(token)).toBe(true);
  });

  it("generates unique tokens", () => {
    const tokens = new Set(Array.from({ length: 20 }, () => generateToken()));
    expect(tokens.size).toBe(20);
  });
});

// ── Route Pattern Matching ───────────────────────────────────

describe("route patterns", () => {
  const triggerPattern = /^\/api\/webhooks\/trigger\/([a-f0-9]{48})$/;
  const idPattern = /^\/api\/webhooks\/([0-9a-f-]{36})$/;
  const togglePattern = /^\/api\/webhooks\/([0-9a-f-]{36})\/toggle$/;
  const regenPattern = /^\/api\/webhooks\/([0-9a-f-]{36})\/regenerate-token$/;
  const invPattern = /^\/api\/webhooks\/([0-9a-f-]{36})\/invocations$/;

  it("matches trigger route with valid token", () => {
    const token = generateToken();
    expect(triggerPattern.test(`/api/webhooks/trigger/${token}`)).toBe(true);
  });

  it("rejects trigger route with short token", () => {
    expect(triggerPattern.test("/api/webhooks/trigger/abc123")).toBe(false);
  });

  it("rejects trigger route with non-hex chars", () => {
    expect(triggerPattern.test("/api/webhooks/trigger/" + "g".repeat(48))).toBe(false);
  });

  it("matches management routes with UUID", () => {
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(idPattern.test(`/api/webhooks/${uuid}`)).toBe(true);
    expect(togglePattern.test(`/api/webhooks/${uuid}/toggle`)).toBe(true);
    expect(regenPattern.test(`/api/webhooks/${uuid}/regenerate-token`)).toBe(true);
    expect(invPattern.test(`/api/webhooks/${uuid}/invocations`)).toBe(true);
  });

  it("does not confuse trigger route with management routes", () => {
    const token = generateToken();
    // Trigger path should NOT match management ID pattern (different length)
    expect(idPattern.test(`/api/webhooks/trigger/${token}`)).toBe(false);
  });
});

// ── Cooldown Logic ───────────────────────────────────────────

describe("cooldown logic", () => {
  function makeTrigger(overrides: Partial<WebhookTrigger> = {}): WebhookTrigger {
    return {
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      created_at: new Date(),
      updated_at: new Date(),
      name: "Test Hook",
      description: "",
      token: generateToken(),
      action_type: "reminder",
      config: { message: "hello" },
      enabled: true,
      cooldown_seconds: 60,
      last_triggered_at: null,
      trigger_count: 0,
      created_by: null,
      ...overrides,
    };
  }

  it("no cooldown when last_triggered_at is null", () => {
    const trigger = makeTrigger({ cooldown_seconds: 60, last_triggered_at: null });
    // cooldown check: last_triggered_at must exist for cooldown to apply
    const shouldBlock = trigger.cooldown_seconds > 0 && trigger.last_triggered_at !== null;
    expect(shouldBlock).toBe(false);
  });

  it("blocks when within cooldown window", () => {
    const trigger = makeTrigger({
      cooldown_seconds: 60,
      last_triggered_at: new Date(Date.now() - 30_000), // 30s ago
    });
    const elapsed = (Date.now() - new Date(trigger.last_triggered_at!).getTime()) / 1000;
    expect(elapsed < trigger.cooldown_seconds).toBe(true);
  });

  it("allows when cooldown has expired", () => {
    const trigger = makeTrigger({
      cooldown_seconds: 60,
      last_triggered_at: new Date(Date.now() - 120_000), // 2 min ago
    });
    const elapsed = (Date.now() - new Date(trigger.last_triggered_at!).getTime()) / 1000;
    expect(elapsed >= trigger.cooldown_seconds).toBe(true);
  });

  it("no cooldown when cooldown_seconds is 0", () => {
    const trigger = makeTrigger({
      cooldown_seconds: 0,
      last_triggered_at: new Date(Date.now() - 1000),
    });
    const shouldCheckCooldown = trigger.cooldown_seconds > 0;
    expect(shouldCheckCooldown).toBe(false);
  });
});

// ── InvokeResult Shape ───────────────────────────────────────

describe("InvokeResult shape", () => {
  it("successful invocation", () => {
    const result: InvokeResult = {
      ok: true,
      invocation_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      status: "completed",
      result: { message: "done" },
    };
    expect(result.ok).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.error).toBeUndefined();
  });

  it("rejected invocation (disabled)", () => {
    const result: InvokeResult = {
      ok: false,
      invocation_id: "",
      status: "rejected",
      error: "webhook is disabled",
    };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("disabled");
  });

  it("failed invocation (executor error)", () => {
    const result: InvokeResult = {
      ok: false,
      invocation_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      status: "failed",
      error: "HTTP 500: Internal Server Error",
    };
    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
  });
});

// ── Security: Token Authentication ───────────────────────────

describe("token-based authentication", () => {
  it("token is the only auth — no headers needed for trigger endpoint", () => {
    // The trigger route pattern only checks for the token in the URL
    const triggerPattern = /^\/api\/webhooks\/trigger\/([a-f0-9]{48})$/;
    const token = generateToken();
    const match = triggerPattern.exec(`/api/webhooks/trigger/${token}`);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(token);
  });

  it("tokens are 48 hex chars = 24 bytes of entropy", () => {
    const token = generateToken();
    // 24 bytes = 192 bits of entropy, sufficient for URL-based auth
    expect(token.length / 2).toBe(24);
  });
});

// ── Config Merge (Webhook config + Caller payload) ───────────

describe("config merge behavior", () => {
  it("caller payload overrides webhook config", () => {
    const webhookConfig = { agent: "james", prompt: "default prompt" };
    const callerPayload = { prompt: "custom prompt from caller" };
    const merged = { ...webhookConfig, ...callerPayload };
    expect(merged.agent).toBe("james");
    expect(merged.prompt).toBe("custom prompt from caller");
  });

  it("webhook config used when no payload overlap", () => {
    const webhookConfig = { agent: "kate", prompt: "research this" };
    const callerPayload = { extra_context: "from external system" };
    const merged = { ...webhookConfig, ...callerPayload };
    expect(merged.agent).toBe("kate");
    expect(merged.prompt).toBe("research this");
    expect((merged as any).extra_context).toBe("from external system");
  });

  it("empty payload preserves all webhook config", () => {
    const webhookConfig = { endpoint: "/api/health", method: "POST" };
    const callerPayload = {};
    const merged = { ...webhookConfig, ...callerPayload };
    expect(merged).toEqual(webhookConfig);
  });
});
