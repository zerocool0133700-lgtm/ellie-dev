import { describe, it, expect } from "bun:test";
import { parseSlashCommand, classifyIntent } from "./intent-classifier.ts";

// ── parseSlashCommand ─────────────────────────────────────────

describe("parseSlashCommand", () => {
  it("parses /dev command", () => {
    const result = parseSlashCommand("/dev fix the login bug");
    expect(result).not.toBeNull();
    expect(result!.agent).toBe("dev");
    expect(result!.strippedMessage).toBe("fix the login bug");
  });

  it("parses /research command", () => {
    const result = parseSlashCommand("/research what is quantum computing");
    expect(result).not.toBeNull();
    expect(result!.agent).toBe("research");
    expect(result!.strippedMessage).toBe("what is quantum computing");
  });

  it("parses /content command", () => {
    const result = parseSlashCommand("/content write a blog post");
    expect(result).not.toBeNull();
    expect(result!.agent).toBe("content");
  });

  it("parses /finance command", () => {
    const result = parseSlashCommand("/finance check my budget");
    expect(result).not.toBeNull();
    expect(result!.agent).toBe("finance");
  });

  it("parses /strategy command", () => {
    const result = parseSlashCommand("/strategy plan Q3 roadmap");
    expect(result).not.toBeNull();
    expect(result!.agent).toBe("strategy");
  });

  it("parses /critic command", () => {
    const result = parseSlashCommand("/critic review this proposal");
    expect(result).not.toBeNull();
    expect(result!.agent).toBe("critic");
  });

  it("parses /general command", () => {
    const result = parseSlashCommand("/general hello");
    expect(result).not.toBeNull();
    expect(result!.agent).toBe("general");
  });

  it("handles bare slash command with no message", () => {
    const result = parseSlashCommand("/dev");
    expect(result).not.toBeNull();
    expect(result!.agent).toBe("dev");
    expect(result!.strippedMessage).toBe("/dev"); // stripped is empty → falls back to full message
  });

  it("returns null for non-slash messages", () => {
    expect(parseSlashCommand("just a normal message")).toBeNull();
    expect(parseSlashCommand("hey can you /dev this")).toBeNull();
  });

  it("returns null for unknown slash commands", () => {
    expect(parseSlashCommand("/unknown do something")).toBeNull();
    expect(parseSlashCommand("/analytics report")).toBeNull();
  });

  it("handles leading whitespace", () => {
    const result = parseSlashCommand("  /dev fix it");
    expect(result).not.toBeNull();
    expect(result!.agent).toBe("dev");
  });

  it("does not match mid-message slash commands", () => {
    expect(parseSlashCommand("please /dev fix it")).toBeNull();
  });
});

// ── classifyIntent (slash command path) ───────────────────────

describe("classifyIntent — slash commands", () => {
  it("classifies /dev as dev agent with full confidence", async () => {
    const result = await classifyIntent("/dev implement feature X", "test", "user1");

    expect(result.agent_name).toBe("dev");
    expect(result.rule_name).toBe("slash_command");
    expect(result.confidence).toBe(1.0);
    expect(result.execution_mode).toBe("single");
    expect(result.strippedMessage).toBe("implement feature X");
  });

  it("classifies /research correctly", async () => {
    const result = await classifyIntent("/research find competitors", "test", "user1");

    expect(result.agent_name).toBe("research");
    expect(result.rule_name).toBe("slash_command");
    expect(result.confidence).toBe(1.0);
  });

  it("classifies /strategy correctly", async () => {
    const result = await classifyIntent("/strategy plan rollout", "test", "user1");

    expect(result.agent_name).toBe("strategy");
    expect(result.rule_name).toBe("slash_command");
  });

  it("falls back to general when no LLM and no session", async () => {
    // Without initClassifier(), _anthropic is null, _supabase is null
    // Non-slash messages should fall back to general
    const result = await classifyIntent("just a normal message", "test", "user1");

    expect(result.agent_name).toBe("general");
    expect(result.rule_name).toBe("no_anthropic_fallback");
    expect(result.confidence).toBe(0);
  });
});
