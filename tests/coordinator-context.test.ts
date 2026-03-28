/**
 * CoordinatorContext Tests
 *
 * Tests for the coordinator context manager that tracks Messages API
 * conversation history and manages context pressure / compaction.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { CoordinatorContext, type ContextPressureLevel } from "../src/coordinator-context.ts";

describe("CoordinatorContext", () => {
  let ctx: CoordinatorContext;

  beforeEach(() => {
    ctx = new CoordinatorContext({
      systemPrompt: "You are a helpful coordinator.",
      maxTokens: 10000,
    });
  });

  // ── 1. Initialization ──────────────────────────────────────────────────────

  test("initializes with system prompt and empty messages", () => {
    expect(ctx.getSystemPrompt()).toBe("You are a helpful coordinator.");
    expect(ctx.getMessages()).toEqual([]);
  });

  // ── 2. addUserMessage ──────────────────────────────────────────────────────

  test("addUserMessage appends user message to history", () => {
    ctx.addUserMessage("Hello, world!");
    const messages = ctx.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Hello, world!");
  });

  // ── 3. addAssistantMessage ─────────────────────────────────────────────────

  test("addAssistantMessage appends tool use blocks", () => {
    const toolUseBlock = {
      type: "tool_use" as const,
      id: "tu_123",
      name: "dispatch_agent",
      input: { task: "research something" },
    };
    ctx.addAssistantMessage([toolUseBlock]);
    const messages = ctx.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
    expect(Array.isArray(messages[0].content)).toBe(true);
    expect((messages[0].content as any[])[0]).toEqual(toolUseBlock);
  });

  // ── 4. addToolResult ───────────────────────────────────────────────────────

  test("addToolResult appends tool result as user message", () => {
    ctx.addToolResult("tu_123", "The research is complete.");
    const messages = ctx.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    const content = messages[0].content as any[];
    expect(Array.isArray(content)).toBe(true);
    expect(content[0].type).toBe("tool_result");
    expect(content[0].tool_use_id).toBe("tu_123");
    expect(content[0].content).toBe("The research is complete.");
  });

  // ── 5. getPressure — normal ────────────────────────────────────────────────

  test("getPressure returns normal when well under limit", () => {
    ctx.recordTokenUsage(1000); // 10% of 10000
    expect(ctx.getPressure()).toBe("normal");
  });

  // ── 6. getPressure — warm ─────────────────────────────────────────────────

  test("getPressure returns warm at 50-70%", () => {
    ctx.recordTokenUsage(6000); // 60% of 10000
    expect(ctx.getPressure()).toBe("warm");
  });

  // ── 7. getPressure — hot ──────────────────────────────────────────────────

  test("getPressure returns hot at 70-85%", () => {
    ctx.recordTokenUsage(7500); // 75% of 10000
    expect(ctx.getPressure()).toBe("hot");
  });

  // ── 8. getPressure — critical ─────────────────────────────────────────────

  test("getPressure returns critical above 85%", () => {
    ctx.recordTokenUsage(9000); // 90% of 10000
    expect(ctx.getPressure()).toBe("critical");
  });

  // ── 9. compact — warm ─────────────────────────────────────────────────────

  test("compact at warm level reduces message count", () => {
    // Add 10 messages (alternating user/assistant to be valid)
    for (let i = 0; i < 5; i++) {
      ctx.addUserMessage(`User message ${i}`);
      ctx.addAssistantMessage([{ type: "text" as const, text: `Assistant response ${i}` }]);
    }
    expect(ctx.getMessages()).toHaveLength(10);

    ctx.compact("warm"); // keeps last 6, summarizes rest

    // After compaction: summary message + up to 6 kept = at most 7
    expect(ctx.getMessages().length).toBeLessThanOrEqual(7);
    expect(ctx.getMessages().length).toBeGreaterThan(0);
  });

  // ── 10. compact — critical ────────────────────────────────────────────────

  test("compact at critical level keeps at most 4 messages (2 kept + summary)", () => {
    // Add 10 messages
    for (let i = 0; i < 5; i++) {
      ctx.addUserMessage(`User message ${i}`);
      ctx.addAssistantMessage([{ type: "text" as const, text: `Assistant response ${i}` }]);
    }
    expect(ctx.getMessages()).toHaveLength(10);

    ctx.compact("critical"); // keeps last 2 messages, prepends summary

    // After compaction: summary message + 2 kept = at most 3 (or 4 if merging needed)
    expect(ctx.getMessages().length).toBeLessThanOrEqual(4);
    expect(ctx.getMessages().length).toBeGreaterThan(0);
  });

  // ── 11. getCompactionSummary ───────────────────────────────────────────────

  test("getCompactionSummary returns dispatch info from conversation", () => {
    // Add a tool use + result for dispatch_agent
    ctx.addUserMessage("Please research something for me.");
    ctx.addAssistantMessage([
      {
        type: "tool_use" as const,
        id: "tu_abc",
        name: "dispatch_agent",
        input: { task: "Research the topic", agent: "kate" },
      },
    ]);
    ctx.addToolResult("tu_abc", "Research complete: found 3 key findings.");

    const summary = ctx.getCompactionSummary();
    expect(typeof summary).toBe("string");
    expect(summary.length).toBeGreaterThan(0);
    // Should mention dispatch_agent or the agent name
    expect(summary.toLowerCase()).toMatch(/dispatch|agent|kate|research/);
  });
});
