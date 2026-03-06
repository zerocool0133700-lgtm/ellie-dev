/**
 * Tests for Conversation River Promoter — ELLIE-610
 *
 * Covers: path generation, validation, frontmatter building,
 * body building, document building, promote documents.
 */

import { describe, it, expect } from "bun:test";

import {
  generateConversationPath,
  validateContext,
  buildFrontmatter,
  buildBody,
  buildRiverDocument,
  buildPromoteDocument,
  type ConversationContext,
} from "../src/conversation-river-promoter";

// ── Helpers ──────────────────────────────────────────────────────────────────

const FIXED_DATE = new Date("2026-03-05T18:30:00.000Z");

function makeContext(overrides?: Partial<ConversationContext>): ConversationContext {
  return {
    conversationId: "abc123-def456",
    channel: "telegram",
    summary: "Discussed the new agent architecture and decided on ant archetype for dev.",
    facts: [
      "Ant archetype uses depth-first cognitive style",
      "Dev role handles code-level work",
    ],
    actionItems: [
      "Implement archetype loader",
      "Write tests for role schema",
    ],
    workItemId: "ELLIE-607",
    agent: "dev",
    messageCount: 15,
    startedAt: "2026-03-05T17:00:00.000Z",
    endedAt: "2026-03-05T18:30:00.000Z",
    ...overrides,
  };
}

// ── generateConversationPath ────────────────────────────────────────────────

describe("generateConversationPath", () => {
  it("generates correct path with date", () => {
    const path = generateConversationPath("abc123", FIXED_DATE);
    expect(path).toBe("conversations/abc123-2026-03-05.md");
  });

  it("uses current date when none provided", () => {
    const path = generateConversationPath("abc123");
    expect(path).toMatch(/^conversations\/abc123-\d{4}-\d{2}-\d{2}\.md$/);
  });

  it("preserves full conversation ID", () => {
    const path = generateConversationPath("abc123-def456-ghi789", FIXED_DATE);
    expect(path).toBe("conversations/abc123-def456-ghi789-2026-03-05.md");
  });
});

// ── validateContext ─────────────────────────────────────────────────────────

describe("validateContext", () => {
  it("validates complete context", () => {
    const result = validateContext(makeContext());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails without conversationId", () => {
    const result = validateContext(makeContext({ conversationId: "" }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("conversationId is required");
  });

  it("fails without channel", () => {
    const result = validateContext(makeContext({ channel: "" }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("channel is required");
  });

  it("fails without any content (no summary, facts, or actionItems)", () => {
    const result = validateContext({
      conversationId: "abc",
      channel: "telegram",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("At least one"))).toBe(true);
  });

  it("passes with only summary", () => {
    const result = validateContext({
      conversationId: "abc",
      channel: "telegram",
      summary: "A brief summary.",
    });
    expect(result.valid).toBe(true);
  });

  it("passes with only facts", () => {
    const result = validateContext({
      conversationId: "abc",
      channel: "telegram",
      facts: ["A fact"],
    });
    expect(result.valid).toBe(true);
  });

  it("passes with only actionItems", () => {
    const result = validateContext({
      conversationId: "abc",
      channel: "telegram",
      actionItems: ["Do something"],
    });
    expect(result.valid).toBe(true);
  });

  it("reports multiple errors", () => {
    const result = validateContext({
      conversationId: "",
      channel: "",
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ── buildFrontmatter ────────────────────────────────────────────────────────

describe("buildFrontmatter", () => {
  it("includes required fields", () => {
    const fm = buildFrontmatter(makeContext());
    expect(fm.type).toBe("conversation");
    expect(fm.conversation_id).toBe("abc123-def456");
    expect(fm.channel).toBe("telegram");
  });

  it("includes optional fields when present", () => {
    const fm = buildFrontmatter(makeContext());
    expect(fm.work_item_id).toBe("ELLIE-607");
    expect(fm.agent).toBe("dev");
    expect(fm.message_count).toBe(15);
    expect(fm.started_at).toBe("2026-03-05T17:00:00.000Z");
    expect(fm.ended_at).toBe("2026-03-05T18:30:00.000Z");
  });

  it("omits optional fields when absent", () => {
    const fm = buildFrontmatter({
      conversationId: "abc",
      channel: "telegram",
      summary: "test",
    });
    expect(fm.work_item_id).toBeUndefined();
    expect(fm.agent).toBeUndefined();
    expect(fm.message_count).toBeUndefined();
  });

  it("includes promoted_at timestamp", () => {
    const fm = buildFrontmatter(makeContext());
    expect(fm.promoted_at).toBeTruthy();
    expect(typeof fm.promoted_at).toBe("string");
  });
});

// ── buildBody ───────────────────────────────────────────────────────────────

describe("buildBody", () => {
  it("includes title with work item", () => {
    const body = buildBody(makeContext());
    expect(body).toContain("# Conversation — ELLIE-607 (telegram)");
  });

  it("includes title without work item", () => {
    const body = buildBody(makeContext({ workItemId: undefined }));
    expect(body).toContain("# Conversation — telegram");
  });

  it("includes summary section", () => {
    const body = buildBody(makeContext());
    expect(body).toContain("## Summary");
    expect(body).toContain("agent architecture");
  });

  it("includes facts section", () => {
    const body = buildBody(makeContext());
    expect(body).toContain("## Extracted Facts");
    expect(body).toContain("- Ant archetype uses depth-first");
    expect(body).toContain("- Dev role handles code-level");
  });

  it("includes action items with checkboxes", () => {
    const body = buildBody(makeContext());
    expect(body).toContain("## Action Items");
    expect(body).toContain("- [ ] Implement archetype loader");
    expect(body).toContain("- [ ] Write tests for role schema");
  });

  it("includes session details", () => {
    const body = buildBody(makeContext());
    expect(body).toContain("## Session Details");
    expect(body).toContain("**Agent**: dev");
    expect(body).toContain("**Channel**: telegram");
    expect(body).toContain("**Messages**: 15");
    expect(body).toContain("**Work Item**: ELLIE-607");
  });

  it("omits summary section when no summary", () => {
    const body = buildBody(makeContext({ summary: undefined }));
    expect(body).not.toContain("## Summary");
  });

  it("omits facts section when no facts", () => {
    const body = buildBody(makeContext({ facts: undefined }));
    expect(body).not.toContain("## Extracted Facts");
  });

  it("omits action items section when none", () => {
    const body = buildBody(makeContext({ actionItems: undefined }));
    expect(body).not.toContain("## Action Items");
  });

  it("omits empty facts array", () => {
    const body = buildBody(makeContext({ facts: [] }));
    expect(body).not.toContain("## Extracted Facts");
  });
});

// ── buildRiverDocument ──────────────────────────────────────────────────────

describe("buildRiverDocument", () => {
  it("builds a complete document", () => {
    const doc = buildRiverDocument(makeContext(), FIXED_DATE);
    expect(doc).not.toBeNull();
    expect(doc!.path).toBe("conversations/abc123-def456-2026-03-05.md");
    expect(doc!.content).toContain("---");
    expect(doc!.content).toContain("type: conversation");
    expect(doc!.content).toContain("# Conversation — ELLIE-607");
    expect(doc!.frontmatter.type).toBe("conversation");
  });

  it("returns null for invalid context", () => {
    const doc = buildRiverDocument({ conversationId: "", channel: "" });
    expect(doc).toBeNull();
  });

  it("content starts with frontmatter block", () => {
    const doc = buildRiverDocument(makeContext(), FIXED_DATE);
    expect(doc!.content).toMatch(/^---\n/);
    // Should have closing ---
    const fmEnd = doc!.content.indexOf("\n---\n", 4);
    expect(fmEnd).toBeGreaterThan(0);
  });

  it("frontmatter contains conversation_id", () => {
    const doc = buildRiverDocument(makeContext(), FIXED_DATE);
    expect(doc!.content).toContain("conversation_id: abc123-def456");
  });

  it("frontmatter contains channel", () => {
    const doc = buildRiverDocument(makeContext(), FIXED_DATE);
    expect(doc!.content).toContain("channel: telegram");
  });

  it("body contains all sections", () => {
    const doc = buildRiverDocument(makeContext(), FIXED_DATE);
    expect(doc!.content).toContain("## Summary");
    expect(doc!.content).toContain("## Extracted Facts");
    expect(doc!.content).toContain("## Action Items");
    expect(doc!.content).toContain("## Session Details");
  });

  it("minimal document with just summary", () => {
    const doc = buildRiverDocument({
      conversationId: "min-123",
      channel: "ellie-chat",
      summary: "Quick test conversation.",
    }, FIXED_DATE);
    expect(doc).not.toBeNull();
    expect(doc!.path).toBe("conversations/min-123-2026-03-05.md");
    expect(doc!.content).toContain("## Summary");
    expect(doc!.content).toContain("Quick test conversation.");
    expect(doc!.content).not.toContain("## Extracted Facts");
    expect(doc!.content).not.toContain("## Action Items");
  });
});

// ── buildPromoteDocument ────────────────────────────────────────────────────

describe("buildPromoteDocument", () => {
  it("builds a document with manually_promoted flag", () => {
    const doc = buildPromoteDocument(makeContext(), FIXED_DATE);
    expect(doc).not.toBeNull();
    expect(doc!.frontmatter.manually_promoted).toBe(true);
    expect(doc!.content).toContain("manually_promoted: true");
  });

  it("returns null for invalid context", () => {
    const doc = buildPromoteDocument({ conversationId: "", channel: "" });
    expect(doc).toBeNull();
  });

  it("has same path as regular document", () => {
    const regular = buildRiverDocument(makeContext(), FIXED_DATE);
    const promoted = buildPromoteDocument(makeContext(), FIXED_DATE);
    expect(promoted!.path).toBe(regular!.path);
  });

  it("contains all body sections", () => {
    const doc = buildPromoteDocument(makeContext(), FIXED_DATE);
    expect(doc!.content).toContain("## Summary");
    expect(doc!.content).toContain("## Session Details");
  });
});

// ── Full scenario ───────────────────────────────────────────────────────────

describe("full scenario", () => {
  it("auto-close: conversation closes and writes to River", () => {
    const ctx: ConversationContext = {
      conversationId: "conv-001-close",
      channel: "telegram",
      summary: "Worked on ELLIE-607 agent identity binding. Implemented registration, validation, and resolution. All tests passing.",
      facts: [
        "Agent identity bindings map agents to archetype + role pairs",
        "Default bindings: dev→ant, research→owl, content→bee",
        "Validation warns on missing archetype/role files (non-fatal)",
      ],
      actionItems: [
        "Write prompt identity injector (ELLIE-608)",
        "Add growth metrics collection (ELLIE-609)",
      ],
      workItemId: "ELLIE-607",
      agent: "dev",
      messageCount: 42,
      startedAt: "2026-03-05T17:00:00.000Z",
      endedAt: "2026-03-05T18:30:00.000Z",
    };

    const doc = buildRiverDocument(ctx, FIXED_DATE);
    expect(doc).not.toBeNull();
    expect(doc!.path).toBe("conversations/conv-001-close-2026-03-05.md");

    // Verify frontmatter
    expect(doc!.frontmatter.type).toBe("conversation");
    expect(doc!.frontmatter.work_item_id).toBe("ELLIE-607");
    expect(doc!.frontmatter.message_count).toBe(42);

    // Verify body structure
    expect(doc!.content).toContain("# Conversation — ELLIE-607 (telegram)");
    expect(doc!.content).toContain("agent identity binding");
    expect(doc!.content).toContain("- Agent identity bindings map agents");
    expect(doc!.content).toContain("- [ ] Write prompt identity injector");
    expect(doc!.content).toContain("**Messages**: 42");
  });

  it("manual promote: user clicks Save to River button", () => {
    const ctx: ConversationContext = {
      conversationId: "conv-002-manual",
      channel: "ellie-chat",
      summary: "Exploring options for the new dashboard layout.",
      agent: "general",
      messageCount: 8,
      startedAt: "2026-03-05T19:00:00.000Z",
    };

    const doc = buildPromoteDocument(ctx, FIXED_DATE);
    expect(doc).not.toBeNull();
    expect(doc!.frontmatter.manually_promoted).toBe(true);
    expect(doc!.content).toContain("# Conversation — ellie-chat");
    expect(doc!.content).not.toContain("## Action Items");
  });

  it("google chat conversation", () => {
    const ctx: ConversationContext = {
      conversationId: "gchat-123",
      channel: "google-chat",
      summary: "Quick sync about deployment schedule.",
      facts: ["Deploy scheduled for Friday 5pm CST"],
      messageCount: 5,
    };

    const doc = buildRiverDocument(ctx, FIXED_DATE);
    expect(doc).not.toBeNull();
    expect(doc!.content).toContain("channel: google-chat");
    expect(doc!.content).toContain("# Conversation — google-chat");
  });
});
