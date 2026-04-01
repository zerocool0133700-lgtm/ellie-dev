/**
 * Off-Hours Prompt Builder — ELLIE-1160
 * Tests for buildOvernightPrompt: Plane ticket fetching, creature skills, prompt assembly.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

// ── Mocks ──────────────────────────────────────────────────

mock.module("../src/logger.ts", () => ({
  log: { child: () => ({ info: mock(), warn: mock(), error: mock(), debug: mock() }) },
}));

const mockGetSkillsForCreature = mock();
mock.module("../../ellie-forest/src/creature-skills.ts", () => ({
  getSkillsForCreature: mockGetSkillsForCreature,
}));

const mockSql = Object.assign(
  mock(() => Promise.resolve([])),
  { unsafe: mock(() => Promise.resolve([])) },
);
mock.module("../../ellie-forest/src/db.ts", () => ({
  default: mockSql,
}));

// ── Imports ────────────────────────────────────────────────

import { buildOvernightPrompt } from "../src/overnight/prompt-builder.ts";

// ── Setup ──────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  mockGetSkillsForCreature.mockReset();
  mockSql.mockReset();
  mockGetSkillsForCreature.mockImplementation(() => Promise.resolve([]));
  mockSql.mockImplementation(() => Promise.resolve([]));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

// ── buildOvernightPrompt ───────────────────────────────────

describe("buildOvernightPrompt", () => {
  it("returns prompt with task title and content", async () => {
    const { prompt, systemPrompt } = await buildOvernightPrompt({
      taskTitle: "Fix auth bug",
      taskContent: "The login form crashes on empty email",
      assignedAgent: "dev",
    });

    expect(prompt).toContain("# Task: Fix auth bug");
    expect(prompt).toContain("The login form crashes on empty email");
    expect(systemPrompt).toContain("dev agent");
  });

  it("includes agent name in system prompt", async () => {
    const { systemPrompt } = await buildOvernightPrompt({
      taskTitle: "Research task",
      taskContent: "Find alternatives",
      assignedAgent: "research",
    });

    expect(systemPrompt).toContain("research agent");
    expect(systemPrompt).toContain("overnight autonomous task");
  });

  it("system prompt includes standard instructions", async () => {
    const { systemPrompt } = await buildOvernightPrompt({
      taskTitle: "Any task",
      taskContent: "Content",
      assignedAgent: "dev",
    });

    expect(systemPrompt).toContain("Commit your changes");
    expect(systemPrompt).toContain("Create a PR");
    expect(systemPrompt).toContain("don't loop");
  });
});

// ── Plane ticket context ───────────────────────────────────

describe("buildOvernightPrompt — Plane ticket context", () => {
  it("fetches Plane ticket when workItemId is provided", async () => {
    process.env.PLANE_API_KEY = "test-key";

    globalThis.fetch = mock(async () => new Response(JSON.stringify({
      results: [{
        sequence_id: 42,
        name: "Fix the widget",
        description_html: "<p>Detailed description of the widget issue</p>",
      }],
    }))) as any;

    const { prompt } = await buildOvernightPrompt({
      taskTitle: "Fix widget",
      taskContent: "Widget is broken",
      assignedAgent: "dev",
      workItemId: "ELLIE-42",
    });

    expect(prompt).toContain("ELLIE-42");
    expect(prompt).toContain("Fix the widget");
    expect(prompt).toContain("Detailed description of the widget issue");
    // HTML tags should be stripped
    expect(prompt).not.toContain("<p>");
  });

  it("skips Plane fetch when no workItemId", async () => {
    let fetchCalled = false;
    globalThis.fetch = mock(async () => {
      fetchCalled = true;
      return new Response("{}");
    }) as any;

    await buildOvernightPrompt({
      taskTitle: "Simple task",
      taskContent: "Do something",
      assignedAgent: "dev",
    });

    expect(fetchCalled).toBe(false);
  });

  it("skips Plane fetch when PLANE_API_KEY is missing", async () => {
    delete process.env.PLANE_API_KEY;

    let fetchCalled = false;
    globalThis.fetch = mock(async () => {
      fetchCalled = true;
      return new Response("{}");
    }) as any;

    const { prompt } = await buildOvernightPrompt({
      taskTitle: "Task",
      taskContent: "Content",
      assignedAgent: "dev",
      workItemId: "ELLIE-99",
    });

    expect(fetchCalled).toBe(false);
    // Prompt still has task info, just no ticket context
    expect(prompt).toContain("# Task: Task");
  });

  it("handles Plane API failure gracefully", async () => {
    process.env.PLANE_API_KEY = "test-key";

    globalThis.fetch = mock(async () => {
      throw new Error("Network error");
    }) as any;

    // Should not throw
    const { prompt } = await buildOvernightPrompt({
      taskTitle: "Task",
      taskContent: "Content",
      assignedAgent: "dev",
      workItemId: "ELLIE-50",
    });

    expect(prompt).toContain("# Task: Task");
  });

  it("handles invalid workItemId format gracefully", async () => {
    process.env.PLANE_API_KEY = "test-key";

    let fetchCalled = false;
    globalThis.fetch = mock(async () => {
      fetchCalled = true;
      return new Response("{}");
    }) as any;

    await buildOvernightPrompt({
      taskTitle: "Task",
      taskContent: "Content",
      assignedAgent: "dev",
      workItemId: "INVALID-FORMAT",
    });

    // Should not attempt fetch for invalid format
    expect(fetchCalled).toBe(false);
  });
});

// ── Agent skill context ────────────────────────────────────

describe("buildOvernightPrompt — agent skills", () => {
  it("includes skills in system prompt when agent has skills", async () => {
    mockSql.mockImplementation(() => Promise.resolve([{ id: "entity-1" }]));
    mockGetSkillsForCreature.mockImplementation(() => Promise.resolve(["coding", "research", "git"]));

    const { systemPrompt } = await buildOvernightPrompt({
      taskTitle: "Task",
      taskContent: "Content",
      assignedAgent: "dev",
    });

    expect(systemPrompt).toContain("Your Skills");
    expect(systemPrompt).toContain("coding");
    expect(systemPrompt).toContain("research");
    expect(systemPrompt).toContain("git");
  });

  it("omits skills section when agent has no skills", async () => {
    mockSql.mockImplementation(() => Promise.resolve([{ id: "entity-1" }]));
    mockGetSkillsForCreature.mockImplementation(() => Promise.resolve([]));

    const { systemPrompt } = await buildOvernightPrompt({
      taskTitle: "Task",
      taskContent: "Content",
      assignedAgent: "dev",
    });

    expect(systemPrompt).not.toContain("Your Skills");
  });

  it("omits skills section when agent entity not found", async () => {
    mockSql.mockImplementation(() => Promise.resolve([]));

    const { systemPrompt } = await buildOvernightPrompt({
      taskTitle: "Task",
      taskContent: "Content",
      assignedAgent: "unknown-agent",
    });

    expect(systemPrompt).not.toContain("Your Skills");
  });

  it("handles DB error in skill lookup gracefully", async () => {
    mockSql.mockImplementation(() => Promise.reject(new Error("DB down")));

    const { systemPrompt } = await buildOvernightPrompt({
      taskTitle: "Task",
      taskContent: "Content",
      assignedAgent: "dev",
    });

    // Should not throw, just omit skills
    expect(systemPrompt).not.toContain("Your Skills");
    expect(systemPrompt).toContain("dev agent");
  });
});
