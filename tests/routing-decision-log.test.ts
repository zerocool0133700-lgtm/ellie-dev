import { describe, it, expect, mock } from "bun:test";

describe("routing-decision-log", () => {
  it("builds a routing decision record from classification result", () => {
    const { buildRoutingDecision } = require("../src/routing-decision-log");

    const classification = {
      agent_name: "dev",
      rule_name: "skill_trigger",
      confidence: 0.88,
      reasoning: "Trigger 'schedule' matched ums-calendar skill on general agent",
      skill_name: "ums-calendar",
    };

    const decision = buildRoutingDecision({
      classification,
      sessionId: "session-123",
      userMessage: "check my schedule for next week",
      agentsConsidered: ["dev", "general", "research"],
      skillsLoaded: ["ums-calendar", "memory"],
    });

    expect(decision.id).toMatch(/^rd_/);
    expect(decision.agent_chosen).toBe("dev");
    expect(decision.confidence).toBe(0.88);
    expect(decision.match_type).toBe("skill_trigger");
    expect(decision.reasoning).toBe("Trigger 'schedule' matched ums-calendar skill on general agent");
    expect(decision.agents_considered).toEqual(["dev", "general", "research"]);
    expect(decision.skills_loaded).toEqual(["ums-calendar", "memory"]);
    expect(decision.user_message).toBe("check my schedule for next week");
    expect(decision.session_id).toBe("session-123");
  });

  it("generates deterministic reasoning for slash commands", () => {
    const { generateReasoning } = require("../src/routing-decision-log");

    const reasoning = generateReasoning({
      rule_name: "slash_command",
      agent_name: "dev",
      confidence: 1.0,
    });

    expect(reasoning).toBe("Explicit /dev command — direct route");
  });

  it("generates reasoning for skill triggers", () => {
    const { generateReasoning } = require("../src/routing-decision-log");

    const reasoning = generateReasoning({
      rule_name: "skill_trigger",
      agent_name: "general",
      skill_name: "ums-calendar",
      skill_description: "Schedule intelligence via UMS",
    });

    expect(reasoning).toContain("ums-calendar");
    expect(reasoning).toContain("general");
  });

  it("truncates user messages longer than 200 chars", () => {
    const { buildRoutingDecision } = require("../src/routing-decision-log");

    const longMessage = "a".repeat(300);
    const decision = buildRoutingDecision({
      classification: { agent_name: "dev", rule_name: "llm_classification", confidence: 0.8 },
      userMessage: longMessage,
      agentsConsidered: ["dev"],
      skillsLoaded: [],
    });

    expect(decision.user_message.length).toBeLessThanOrEqual(203); // 200 + "..."
  });
});
