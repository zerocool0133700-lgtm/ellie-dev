/**
 * Formation Orchestrator Tests — ELLIE-675
 *
 * Tests for formation orchestration: loading, prompt building,
 * protocol execution, synthesis, error handling, and E2E flows.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  invokeFormation,
  buildAgentFormationPrompt,
  buildSynthesisPrompt,
  _makeMockAgentCallFn,
  _makeMockAgentCallFnWithErrors,
  _makeMockFormationLoader,
  _makeMockFormationSkillMd,
  type OrchestratorDeps,
  type AgentOutput,
} from "../src/formations/orchestrator.ts";
import {
  _makeMockDeps as _makeMockProtocolDeps,
  _resetIdCounter,
} from "../src/formations/protocol.ts";
import type { AgentRole, FormationFrontmatter, FormationMessage } from "../src/types/formation.ts";

// ── Helpers ─────────────────────────────────────────────────────

function makeDeps(opts: {
  agentResponses?: Record<string, string>;
  formations?: Record<string, string>;
  errorAgents?: string[];
} = {}): OrchestratorDeps & { protocolDeps: ReturnType<typeof _makeMockProtocolDeps> } {
  const protocolDeps = _makeMockProtocolDeps();
  const callAgent = opts.errorAgents
    ? _makeMockAgentCallFnWithErrors(opts.errorAgents, opts.agentResponses)
    : _makeMockAgentCallFn(opts.agentResponses);
  const loadFormation = _makeMockFormationLoader(opts.formations);

  return { protocolDeps, callAgent, loadFormation };
}

beforeEach(() => {
  _resetIdCounter();
});

// ── buildAgentFormationPrompt ───────────────────────────────────

describe("buildAgentFormationPrompt", () => {
  const fm: FormationFrontmatter = {
    name: "code-review",
    description: "Multi-agent code review",
    agents: [
      { agent: "dev", role: "author", responsibility: "Present code" },
      { agent: "critic", role: "reviewer", responsibility: "Review code" },
      { agent: "strategy", role: "arbiter", responsibility: "Resolve disputes" },
    ],
    protocol: { pattern: "coordinator", maxTurns: 10, coordinator: "strategy", requiresApproval: false },
  };

  test("includes formation name and description", () => {
    const prompt = buildAgentFormationPrompt(fm.agents[0], fm, "Review this PR", []);
    expect(prompt).toContain('name="code-review"');
    expect(prompt).toContain("Multi-agent code review");
  });

  test("includes agent role and responsibility", () => {
    const prompt = buildAgentFormationPrompt(fm.agents[1], fm, "Review this", []);
    expect(prompt).toContain('agent="critic"');
    expect(prompt).toContain('role="reviewer"');
    expect(prompt).toContain("Review code");
  });

  test("includes other agents", () => {
    const prompt = buildAgentFormationPrompt(fm.agents[0], fm, "Review", []);
    expect(prompt).toContain("<other-agents>");
    expect(prompt).toContain('name="critic"');
    expect(prompt).toContain('name="strategy"');
    // Should not include self
    expect(prompt).not.toContain('<agent name="dev"');
  });

  test("includes user prompt", () => {
    const prompt = buildAgentFormationPrompt(fm.agents[0], fm, "Is this code safe?", []);
    expect(prompt).toContain("<user-prompt>Is this code safe?</user-prompt>");
  });

  test("includes previous messages when provided", () => {
    const messages: FormationMessage[] = [
      {
        id: "1", created_at: new Date(), session_id: "s1", from_agent: "dev",
        to_agent: null, content: "Here is the code", turn_number: 0,
        message_type: "proposal", metadata: {},
      },
      {
        id: "2", created_at: new Date(), session_id: "s1", from_agent: "critic",
        to_agent: null, content: "I see issues", turn_number: 0,
        message_type: "response", metadata: {},
      },
    ];

    const prompt = buildAgentFormationPrompt(fm.agents[2], fm, "Review", messages);
    expect(prompt).toContain("<prior-discussion>");
    expect(prompt).toContain('from="dev"');
    expect(prompt).toContain("Here is the code");
    expect(prompt).toContain('from="critic"');
  });

  test("excludes system messages from prior discussion", () => {
    const messages: FormationMessage[] = [
      {
        id: "1", created_at: new Date(), session_id: "s1", from_agent: "system",
        to_agent: null, content: "Session started", turn_number: 0,
        message_type: "system", metadata: {},
      },
    ];

    const prompt = buildAgentFormationPrompt(fm.agents[0], fm, "Review", messages);
    expect(prompt).not.toContain("Session started");
  });

  test("handles empty previous messages", () => {
    const prompt = buildAgentFormationPrompt(fm.agents[0], fm, "Review", []);
    expect(prompt).not.toContain("<prior-discussion>");
  });
});

// ── buildSynthesisPrompt ────────────────────────────────────────

describe("buildSynthesisPrompt", () => {
  const fm: FormationFrontmatter = {
    name: "strategy-review",
    description: "Strategic decision making",
    agents: [
      { agent: "dev", role: "technical", responsibility: "Technical analysis" },
      { agent: "strategy", role: "business", responsibility: "Business analysis" },
    ],
    protocol: { pattern: "coordinator", maxTurns: 6, coordinator: "strategy", requiresApproval: false },
  };

  test("includes formation context", () => {
    const outputs: AgentOutput[] = [
      { agent: "dev", role: "technical", content: "Technically feasible", roundNumber: 0 },
    ];
    const prompt = buildSynthesisPrompt(fm, "Should we do X?", outputs);
    expect(prompt).toContain('name="strategy-review"');
    expect(prompt).toContain("Strategic decision making");
  });

  test("includes original prompt", () => {
    const prompt = buildSynthesisPrompt(fm, "Should we migrate?", []);
    expect(prompt).toContain("<original-prompt>Should we migrate?</original-prompt>");
  });

  test("includes all agent contributions", () => {
    const outputs: AgentOutput[] = [
      { agent: "dev", role: "technical", content: "Tech analysis here", roundNumber: 0 },
      { agent: "strategy", role: "business", content: "Business analysis here", roundNumber: 0 },
    ];
    const prompt = buildSynthesisPrompt(fm, "Question", outputs);
    expect(prompt).toContain('agent="dev"');
    expect(prompt).toContain("Tech analysis here");
    expect(prompt).toContain('agent="strategy"');
    expect(prompt).toContain("Business analysis here");
  });

  test("includes synthesis instructions", () => {
    const prompt = buildSynthesisPrompt(fm, "Q", []);
    expect(prompt).toContain("facilitator");
    expect(prompt).toContain("Synthesize");
    expect(prompt).toContain("strategy-review");
  });
});

// ── invokeFormation — error cases ───────────────────────────────

describe("invokeFormation — error handling", () => {
  test("returns error when formation not found", async () => {
    const deps = makeDeps();
    const result = await invokeFormation(deps, "nonexistent", "test prompt");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
    expect(result.formationName).toBe("nonexistent");
  });

  test("returns error when formation has invalid format", async () => {
    const deps = makeDeps({
      formations: { "bad-format": "not valid frontmatter at all" },
    });
    const result = await invokeFormation(deps, "bad-format", "test");
    expect(result.success).toBe(false);
    expect(result.error).toContain("invalid SKILL.md format");
  });

  test("returns error when formation fails validation", async () => {
    const deps = makeDeps({
      formations: {
        "invalid": `---
name: invalid
description: Missing agents
agents: []
protocol: {"pattern": "free-form", "maxTurns": 0, "requiresApproval": false}
---

## Objective

Test

## Agent Roles

None

## Interaction Flow

None
`,
      },
    });
    const result = await invokeFormation(deps, "invalid", "test");
    expect(result.success).toBe(false);
    expect(result.error).toContain("validation failed");
  });

  test("handles agent call failures gracefully", async () => {
    const md = _makeMockFormationSkillMd({
      agents: [
        { agent: "dev", role: "lead", responsibility: "Write code" },
        { agent: "critic", role: "reviewer", responsibility: "Review" },
      ],
      protocol: { pattern: "coordinator", maxTurns: 10, coordinator: "dev", requiresApproval: false },
    });

    const deps = makeDeps({
      formations: { "test": md },
      errorAgents: ["critic"],
      agentResponses: { dev: "I synthesize everything." },
    });

    const result = await invokeFormation(deps, "test", "Review this code");
    // Should still succeed — failed agents are recorded but don't stop the formation
    expect(result.success).toBe(true);
    expect(result.agentOutputs.some(o => o.content.includes("Agent error"))).toBe(true);
  });
});

// ── invokeFormation — coordinator/fan-out ───────────────────────

describe("invokeFormation — coordinator pattern", () => {
  test("dispatches to roster agents and synthesizes", async () => {
    const md = _makeMockFormationSkillMd({
      name: "code-review",
      agents: [
        { agent: "dev", role: "lead", responsibility: "Write code" },
        { agent: "critic", role: "reviewer", responsibility: "Review code" },
        { agent: "research", role: "advisor", responsibility: "Find context" },
      ],
      protocol: { pattern: "coordinator", maxTurns: 10, coordinator: "dev", requiresApproval: false },
    });

    const deps = makeDeps({
      formations: { "code-review": md },
      agentResponses: {
        critic: "The code looks good but needs error handling.",
        research: "Similar patterns exist in the auth module.",
        dev: "Based on all feedback: add error handling following auth module patterns.",
      },
    });

    const result = await invokeFormation(deps, "code-review", "Review the new API endpoint");

    expect(result.success).toBe(true);
    expect(result.formationName).toBe("code-review");
    expect(result.sessionId).toBeTruthy();
    expect(result.roundsExecuted).toBe(1);

    // Should have outputs from roster agents (critic + research, not dev who is facilitator)
    expect(result.agentOutputs).toHaveLength(2);
    expect(result.agentOutputs.map(o => o.agent).sort()).toEqual(["critic", "research"]);

    // Synthesis should come from the facilitator (dev)
    expect(result.synthesis).toContain("error handling");
  });

  test("records session in protocol deps", async () => {
    const md = _makeMockFormationSkillMd();
    const deps = makeDeps({
      formations: { "test": md },
      agentResponses: { critic: "LGTM", dev: "Synthesized." },
    });

    const result = await invokeFormation(deps, "test", "Test prompt");

    expect(result.success).toBe(true);
    // Session should exist in the store
    const session = await deps.protocolDeps.sessionStore.getSession(result.sessionId);
    expect(session).not.toBeNull();
    expect(session!.state).toBe("completed");
    expect(session!.formation_name).toBe("test-formation");
  });

  test("messages are recorded in protocol deps", async () => {
    const md = _makeMockFormationSkillMd();
    const deps = makeDeps({
      formations: { "test": md },
      agentResponses: { critic: "Review done", dev: "Final answer" },
    });

    const result = await invokeFormation(deps, "test", "Analyze this");

    // Should have: system start + critic response + dev synthesis + system complete
    expect(deps.protocolDeps.messages.length).toBeGreaterThanOrEqual(3);
    expect(deps.protocolDeps.messages.some(m => m.from_agent === "critic")).toBe(true);
  });
});

// ── invokeFormation — debate pattern ────────────────────────────

describe("invokeFormation — debate pattern", () => {
  test("executes multiple rounds of debate", async () => {
    const md = _makeMockFormationSkillMd({
      name: "architecture-debate",
      agents: [
        { agent: "dev", role: "proposer", responsibility: "Propose approach" },
        { agent: "critic", role: "challenger", responsibility: "Challenge approach" },
        { agent: "strategy", role: "facilitator", responsibility: "Facilitate and decide" },
      ],
      protocol: {
        pattern: "debate",
        maxTurns: 6,
        coordinator: "strategy",
        requiresApproval: false,
      },
    });

    let callCount = 0;
    const deps: OrchestratorDeps = {
      protocolDeps: _makeMockProtocolDeps(),
      callAgent: async (agent) => {
        callCount++;
        return `[${agent}] Round ${Math.floor(callCount / 2)} contribution`;
      },
      loadFormation: _makeMockFormationLoader({ "architecture-debate": md }),
    };

    const result = await invokeFormation(deps, "architecture-debate", "Should we use microservices?", {
      config: { maxRounds: 2, agentTimeoutMs: 5000, synthesisTimeoutMs: 10000, consensusThreshold: 0.5 },
    });

    expect(result.success).toBe(true);
    expect(result.roundsExecuted).toBe(2);
    // dev + critic contribute each round (strategy is facilitator, excluded from debate)
    expect(result.agentOutputs.length).toBe(4); // 2 agents * 2 rounds
  });
});

// ── invokeFormation — pipeline pattern ──────────────────────────

describe("invokeFormation — pipeline pattern", () => {
  test("executes agents in sequential order", async () => {
    const md = _makeMockFormationSkillMd({
      name: "content-pipeline",
      agents: [
        { agent: "research", role: "gatherer", responsibility: "Gather sources" },
        { agent: "content", role: "writer", responsibility: "Write draft" },
        { agent: "critic", role: "editor", responsibility: "Edit and polish" },
      ],
      protocol: {
        pattern: "pipeline",
        maxTurns: 3,
        turnOrder: ["research", "content", "critic"],
        requiresApproval: false,
      },
    });

    const callOrder: string[] = [];
    const deps: OrchestratorDeps = {
      protocolDeps: _makeMockProtocolDeps(),
      callAgent: async (agent) => {
        callOrder.push(agent);
        return `[${agent}] Output`;
      },
      loadFormation: _makeMockFormationLoader({ "content-pipeline": md }),
    };

    const result = await invokeFormation(deps, "content-pipeline", "Write about AI");

    expect(result.success).toBe(true);
    // Agents called in order
    expect(callOrder).toEqual(["research", "content", "critic"]);
    expect(result.agentOutputs).toHaveLength(3);
    expect(result.roundsExecuted).toBe(3);
  });

  test("last agent output is used when no separate facilitator", async () => {
    const md = _makeMockFormationSkillMd({
      name: "simple-pipeline",
      agents: [
        { agent: "research", role: "input", responsibility: "Gather" },
        { agent: "content", role: "output", responsibility: "Produce" },
      ],
      protocol: {
        pattern: "pipeline",
        maxTurns: 2,
        turnOrder: ["research", "content"],
        requiresApproval: false,
      },
    });

    const deps = makeDeps({
      formations: { "simple-pipeline": md },
      agentResponses: {
        research: "Here are the facts",
        content: "Final polished output",
      },
    });

    const result = await invokeFormation(deps, "simple-pipeline", "Write about X");
    expect(result.success).toBe(true);
    // No separate coordinator → last agent's output is the synthesis
    expect(result.synthesis).toBe("Final polished output");
  });
});

// ── invokeFormation — options ───────────────────────────────────

describe("invokeFormation — options", () => {
  test("passes channel and workItemId to session", async () => {
    const md = _makeMockFormationSkillMd();
    const deps = makeDeps({
      formations: { "test": md },
      agentResponses: { critic: "OK", dev: "Done" },
    });

    const result = await invokeFormation(deps, "test", "Review", {
      channel: "telegram",
      workItemId: "ELLIE-675",
    });

    expect(result.success).toBe(true);
    const session = await deps.protocolDeps.sessionStore.getSession(result.sessionId);
    expect(session!.channel).toBe("telegram");
    expect(session!.work_item_id).toBe("ELLIE-675");
  });

  test("custom config overrides defaults", async () => {
    const md = _makeMockFormationSkillMd({
      agents: [
        { agent: "dev", role: "lead", responsibility: "Lead" },
        { agent: "critic", role: "reviewer", responsibility: "Review" },
      ],
      protocol: { pattern: "debate", maxTurns: 20, coordinator: "dev", requiresApproval: false },
    });

    let totalCalls = 0;
    const deps: OrchestratorDeps = {
      protocolDeps: _makeMockProtocolDeps(),
      callAgent: async (agent) => {
        totalCalls++;
        return `[${agent}] response`;
      },
      loadFormation: _makeMockFormationLoader({ "test": md }),
    };

    const result = await invokeFormation(deps, "test", "Debate this", {
      config: { maxRounds: 1, agentTimeoutMs: 1000, synthesisTimeoutMs: 2000, consensusThreshold: 0.5 },
    });

    expect(result.success).toBe(true);
    expect(result.roundsExecuted).toBe(1); // maxRounds override to 1
  });
});

// ── Mock Helpers ────────────────────────────────────────────────

describe("mock helpers", () => {
  test("_makeMockAgentCallFn returns default responses", async () => {
    const fn = _makeMockAgentCallFn();
    const response = await fn("dev", "test prompt");
    expect(response).toContain("[dev]");
  });

  test("_makeMockAgentCallFn uses custom responses", async () => {
    const fn = _makeMockAgentCallFn({ dev: "Custom dev response" });
    expect(await fn("dev", "test")).toBe("Custom dev response");
    // Others get default
    const other = await fn("critic", "test");
    expect(other).toContain("[critic]");
  });

  test("_makeMockAgentCallFnWithErrors throws for error agents", async () => {
    const fn = _makeMockAgentCallFnWithErrors(["critic"]);
    await expect(fn("critic", "test")).rejects.toThrow("timed out");
    // Non-error agents work fine
    const response = await fn("dev", "test");
    expect(response).toContain("[dev]");
  });

  test("_makeMockFormationLoader returns null for unknown slugs", async () => {
    const fn = _makeMockFormationLoader({ "known": "content" });
    expect(await fn("known")).toBe("content");
    expect(await fn("unknown")).toBeNull();
  });

  test("_makeMockFormationSkillMd produces parseable SKILL.md", async () => {
    const md = _makeMockFormationSkillMd({ name: "test-review" });
    expect(md).toContain("name: test-review");
    expect(md).toContain("## Objective");
    expect(md).toContain("## Agent Roles");
    expect(md).toContain("## Interaction Flow");
  });
});

// ── E2E ─────────────────────────────────────────────────────────

describe("E2E: full formation orchestration", () => {
  test("boardroom formation with 3 agents", async () => {
    const md = _makeMockFormationSkillMd({
      name: "boardroom",
      description: "Full board meeting with multiple perspectives",
      agents: [
        { agent: "strategy", role: "facilitator", responsibility: "Facilitate discussion and synthesize" },
        { agent: "dev", role: "technical", responsibility: "Assess technical feasibility" },
        { agent: "finance", role: "financial", responsibility: "Evaluate costs and ROI" },
        { agent: "critic", role: "devil-advocate", responsibility: "Challenge assumptions" },
      ],
      protocol: {
        pattern: "coordinator",
        maxTurns: 10,
        coordinator: "strategy",
        requiresApproval: false,
        conflictResolution: "coordinator-decides",
      },
    });

    const deps = makeDeps({
      formations: { "boardroom": md },
      agentResponses: {
        dev: "Technically feasible. We can build this in 2 sprints using the existing Mountain infrastructure.",
        finance: "Expected cost: $500/month infrastructure. ROI positive within 3 months at current growth.",
        critic: "Risk: scope creep. The Mountain infrastructure is still maturing. Suggest a time-boxed pilot first.",
        strategy: "RECOMMENDATION: Proceed with a 2-week pilot using existing Mountain infrastructure. " +
          "Technical team confirms feasibility (2 sprints). Finance projects positive ROI in 3 months. " +
          "Addressing critic's concern: time-box to limit scope creep risk.",
      },
    });

    const result = await invokeFormation(deps, "boardroom", "Should we build a formation execution engine?", {
      channel: "telegram",
      workItemId: "ELLIE-675",
    });

    expect(result.success).toBe(true);
    expect(result.formationName).toBe("boardroom");
    expect(result.agentOutputs).toHaveLength(3); // dev, finance, critic (strategy is facilitator)
    expect(result.synthesis).toContain("RECOMMENDATION");
    expect(result.synthesis).toContain("pilot");
    expect(result.roundsExecuted).toBe(1);

    // Verify session recorded
    const session = await deps.protocolDeps.sessionStore.getSession(result.sessionId);
    expect(session!.state).toBe("completed");
    expect(session!.formation_name).toBe("boardroom");
    expect(session!.participating_agents).toEqual(["strategy", "dev", "finance", "critic"]);

    // Verify messages trail
    const allMsgs = deps.protocolDeps.messages;
    expect(allMsgs.length).toBeGreaterThanOrEqual(5);
    // Should have contributions from dev, finance, critic + synthesis from strategy + system messages
    expect(allMsgs.some(m => m.from_agent === "dev")).toBe(true);
    expect(allMsgs.some(m => m.from_agent === "finance")).toBe(true);
    expect(allMsgs.some(m => m.from_agent === "critic")).toBe(true);
    expect(allMsgs.some(m => m.from_agent === "strategy" && m.message_type === "decision")).toBe(true);
  });

  test("formation with synthesis fallback on facilitator failure", async () => {
    const md = _makeMockFormationSkillMd({
      name: "fragile",
      agents: [
        { agent: "dev", role: "lead", responsibility: "Lead" },
        { agent: "critic", role: "reviewer", responsibility: "Review" },
      ],
      protocol: { pattern: "coordinator", maxTurns: 10, coordinator: "dev", requiresApproval: false },
    });

    // dev (facilitator) fails during synthesis, critic succeeds
    const deps: OrchestratorDeps = {
      protocolDeps: _makeMockProtocolDeps(),
      callAgent: async (agent, prompt) => {
        if (agent === "dev" && prompt.includes("formation-synthesis")) {
          throw new Error("Synthesis timeout");
        }
        if (agent === "critic") return "Critic's analysis: looks promising.";
        return `[${agent}] response`;
      },
      loadFormation: _makeMockFormationLoader({ "fragile": md }),
    };

    const result = await invokeFormation(deps, "fragile", "Review this");

    // Should still succeed with fallback synthesis
    expect(result.success).toBe(true);
    expect(result.synthesis).toContain("critic");
    expect(result.synthesis).toContain("looks promising");
  });
});
