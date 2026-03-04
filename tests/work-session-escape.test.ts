/**
 * ELLIE-514 — API layer tests: work-session escapeMarkdown.
 *
 * Tests the escapeMarkdown() helper that sanitises text for Telegram
 * MarkdownV2 — special chars like _ * [ ] ( ) ~ ` > # + = | { } . ! -
 * must each be prefixed with a backslash.
 */

import { describe, test, expect, mock } from "bun:test";

// ── Mock all external dependencies ───────────────────────────────────────────

mock.module("grammy", () => ({
  Bot: class {},
  InputFile: class {},
}));

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

mock.module("../src/plane.ts", () => ({
  updateWorkItemOnSessionStart: mock(async () => {}),
  updateWorkItemOnSessionComplete: mock(async () => {}),
}));

mock.module("../../ellie-forest/src/index", () => ({
  startWorkSession: mock(async () => ({
    tree: { id: "t1", created_at: new Date() },
    trunk: {}, creatures: [], branches: [],
  })),
  completeWorkSession: mock(async () => {}),
  pauseWorkSession: mock(async () => {}),
  resumeWorkSession: mock(async () => {}),
  addWorkSessionUpdate: mock(async () => {}),
  addWorkSessionDecision: mock(async () => {}),
  getWorkSessionByPlaneId: mock(async () => null),
  getEntity: mock(async () => null),
  getAgent: mock(async () => null),
}));

mock.module("../src/notification-policy.ts", () => ({
  notify: mock(async () => {}),
}));

mock.module("../src/jobs-ledger.ts", () => ({
  findJobByTreeId: mock(async () => null),
  writeJobTouchpointForAgent: mock(async () => {}),
}));

mock.module("../src/agent-entity-map.ts", () => ({
  resolveEntityName: mock(() => undefined),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { escapeMarkdown } from "../src/api/work-session.ts";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("escapeMarkdown — passthrough", () => {
  test("leaves plain alphanumeric text unchanged", () => {
    expect(escapeMarkdown("Hello world 123")).toBe("Hello world 123");
  });

  test("returns empty string for empty input", () => {
    expect(escapeMarkdown("")).toBe("");
  });
});

describe("escapeMarkdown — individual special chars", () => {
  test("escapes underscore", () => {
    expect(escapeMarkdown("hello_world")).toBe("hello\\_world");
  });

  test("escapes asterisk", () => {
    expect(escapeMarkdown("a*b")).toBe("a\\*b");
  });

  test("escapes opening square bracket", () => {
    expect(escapeMarkdown("[link]")).toBe("\\[link\\]");
  });

  test("escapes closing square bracket", () => {
    expect(escapeMarkdown("end]")).toBe("end\\]");
  });

  test("escapes opening parenthesis", () => {
    expect(escapeMarkdown("(text)")).toBe("\\(text\\)");
  });

  test("escapes tilde", () => {
    expect(escapeMarkdown("~strike~")).toBe("\\~strike\\~");
  });

  test("escapes backtick", () => {
    expect(escapeMarkdown("`code`")).toBe("\\`code\\`");
  });

  test("escapes greater-than sign", () => {
    expect(escapeMarkdown(">quote")).toBe("\\>quote");
  });

  test("escapes hash", () => {
    expect(escapeMarkdown("#heading")).toBe("\\#heading");
  });

  test("escapes plus sign", () => {
    expect(escapeMarkdown("a+b")).toBe("a\\+b");
  });

  test("escapes equals sign", () => {
    expect(escapeMarkdown("a=b")).toBe("a\\=b");
  });

  test("escapes pipe", () => {
    expect(escapeMarkdown("a|b")).toBe("a\\|b");
  });

  test("escapes opening curly brace", () => {
    expect(escapeMarkdown("{key}")).toBe("\\{key\\}");
  });

  test("escapes period", () => {
    expect(escapeMarkdown("end.")).toBe("end\\.");
  });

  test("escapes exclamation mark", () => {
    expect(escapeMarkdown("Yes!")).toBe("Yes\\!");
  });

  test("escapes hyphen/dash", () => {
    expect(escapeMarkdown("foo-bar")).toBe("foo\\-bar");
  });
});

describe("escapeMarkdown — real-world patterns", () => {
  test("escapes work item ID (ELLIE-514 → ELLIE\\-514)", () => {
    expect(escapeMarkdown("ELLIE-514")).toBe("ELLIE\\-514");
  });

  test("escapes bold markdown (**bold**)", () => {
    expect(escapeMarkdown("**bold**")).toBe("\\*\\*bold\\*\\*");
  });

  test("escapes link-style text ([link](url))", () => {
    expect(escapeMarkdown("[link](url)")).toBe("\\[link\\]\\(url\\)");
  });

  test("escapes multiple different chars in one string", () => {
    expect(escapeMarkdown("Hello [world] (123)!")).toBe("Hello \\[world\\] \\(123\\)\\!");
  });

  test("escapes a sentence with period", () => {
    expect(escapeMarkdown("Done. Well done!")).toBe("Done\\. Well done\\!");
  });
});
