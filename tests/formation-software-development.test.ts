/**
 * Software Development Formation Tests — ELLIE-677
 *
 * Validates the software-development formation SKILL.md:
 *   - Pipeline protocol: Research → Dev → Critic → Strategy
 *   - Dev as coordinator/facilitator
 *   - Critic review loop behavior
 *   - Session integration documentation
 *   - Current gaps documentation
 *   - Orchestration invocation via pipeline protocol
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import {
  parseFormation,
  validateFormation,
  validateFormationFile,
  getSection,
  getAgentNames,
  listSectionHeadings,
  hasAllRequiredSections,
  type FormationSchema,
} from "../src/types/formation.ts";

import {
  invokeFormation,
  buildAgentFormationPrompt,
  buildSynthesisPrompt,
  _makeMockAgentCallFn,
  _makeMockAgentCallFnWithErrors,
  _makeMockFormationLoader,
  type OrchestratorDeps,
} from "../src/formations/orchestrator.ts";

import {
  _makeMockDeps as _makeMockProtocolDeps,
  _resetIdCounter,
} from "../src/formations/protocol.ts";

// ── Helpers ─────────────────────────────────────────────────────

const SKILL_PATH = join(import.meta.dir, "../skills/formations/software-development/SKILL.md");

function loadRaw(): string {
  return readFileSync(SKILL_PATH, "utf-8");
}

function makeOrchestratorDeps(responses?: Record<string, string>): OrchestratorDeps {
  const raw = loadRaw();
  return {
    protocolDeps: _makeMockProtocolDeps(),
    callAgent: _makeMockAgentCallFn(responses),
    loadFormation: _makeMockFormationLoader({ "software-development": raw }),
  };
}

// ── Parsing ─────────────────────────────────────────────────────

describe("software-development formation — parsing", () => {
  let raw: string;
  let schema: FormationSchema;

  beforeEach(() => {
    _resetIdCounter();
    raw = loadRaw();
    schema = parseFormation(raw)!;
  });

  it("parses successfully", () => {
    expect(schema).not.toBeNull();
    expect(schema.frontmatter.name).toBe("software-development");
  });

  it("validates with zero errors", () => {
    const result = validateFormation(schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("validateFormationFile round-trips correctly", () => {
    const result = validateFormationFile(raw);
    expect(result.schema).not.toBeNull();
    expect(result.validation.valid).toBe(true);
  });

  it("has correct description", () => {
    expect(schema.frontmatter.description.toLowerCase()).toContain("pipeline");
  });
});

// ── Agents ──────────────────────────────────────────────────────

describe("software-development formation — agents", () => {
  let schema: FormationSchema;

  beforeEach(() => {
    schema = parseFormation(loadRaw())!;
  });

  it("has 4 agents", () => {
    expect(schema.frontmatter.agents).toHaveLength(4);
  });

  it("has the correct agent names", () => {
    const names = getAgentNames(schema);
    expect(names).toEqual(["dev", "research", "critic", "strategy"]);
  });

  it("dev is the implementer role", () => {
    const dev = schema.frontmatter.agents.find(a => a.agent === "dev");
    expect(dev).toBeDefined();
    expect(dev!.role).toBe("implementer");
    expect(dev!.canInitiate).toBe(true);
  });

  it("research is the scout role", () => {
    const research = schema.frontmatter.agents.find(a => a.agent === "research");
    expect(research).toBeDefined();
    expect(research!.role).toBe("scout");
    expect(research!.canInitiate).toBe(true);
  });

  it("critic is the reviewer role and cannot initiate", () => {
    const critic = schema.frontmatter.agents.find(a => a.agent === "critic");
    expect(critic).toBeDefined();
    expect(critic!.role).toBe("reviewer");
    expect(critic!.canInitiate).toBe(false);
  });

  it("strategy is the architect role and cannot initiate", () => {
    const strategy = schema.frontmatter.agents.find(a => a.agent === "strategy");
    expect(strategy).toBeDefined();
    expect(strategy!.role).toBe("architect");
    expect(strategy!.canInitiate).toBe(false);
  });

  it("each agent has a unique role", () => {
    const roles = schema.frontmatter.agents.map(a => a.role);
    expect(new Set(roles).size).toBe(roles.length);
  });

  it("each agent has a non-trivial responsibility", () => {
    for (const agent of schema.frontmatter.agents) {
      expect(agent.responsibility.length).toBeGreaterThan(20);
    }
  });
});

// ── Protocol ────────────────────────────────────────────────────

describe("software-development formation — protocol", () => {
  let schema: FormationSchema;

  beforeEach(() => {
    schema = parseFormation(loadRaw())!;
  });

  it("uses pipeline pattern", () => {
    expect(schema.frontmatter.protocol.pattern).toBe("pipeline");
  });

  it("has dev as coordinator", () => {
    expect(schema.frontmatter.protocol.coordinator).toBe("dev");
  });

  it("has turnOrder: research → dev → critic → strategy", () => {
    expect(schema.frontmatter.protocol.turnOrder).toEqual(["research", "dev", "critic", "strategy"]);
  });

  it("has maxTurns = 12", () => {
    expect(schema.frontmatter.protocol.maxTurns).toBe(12);
  });

  it("uses coordinator-decides conflict resolution", () => {
    expect(schema.frontmatter.protocol.conflictResolution).toBe("coordinator-decides");
  });

  it("does not require approval", () => {
    expect(schema.frontmatter.protocol.requiresApproval).toBe(false);
  });
});

// ── Configuration ───────────────────────────────────────────────

describe("software-development formation — config", () => {
  let schema: FormationSchema;

  beforeEach(() => {
    schema = parseFormation(loadRaw())!;
  });

  it("has development-related triggers", () => {
    expect(schema.frontmatter.triggers).toBeDefined();
    expect(schema.frontmatter.triggers).toContain("implement");
    expect(schema.frontmatter.triggers).toContain("fix bug");
  });

  it("has minAgents = 3", () => {
    expect(schema.frontmatter.minAgents).toBe(3);
  });

  it("has timeoutSeconds = 600", () => {
    expect(schema.frontmatter.timeoutSeconds).toBe(600);
  });
});

// ── Sections ────────────────────────────────────────────────────

describe("software-development formation — sections", () => {
  let schema: FormationSchema;

  beforeEach(() => {
    schema = parseFormation(loadRaw())!;
  });

  it("has all required sections", () => {
    expect(hasAllRequiredSections(schema)).toBe(true);
  });

  it("has Session Integration section", () => {
    const section = getSection(schema, "Session Integration");
    expect(section).not.toBeNull();
    expect(section!.content).toContain("work-session/start");
    expect(section!.content).toContain("work-session/update");
    expect(section!.content).toContain("work-session/complete");
  });

  it("has Current Gaps section identifying 5 gaps", () => {
    const section = getSection(schema, "Current Gaps");
    expect(section).not.toBeNull();
    expect(section!.content).toContain("No formal handoff");
    expect(section!.content).toContain("Critic loop not enforced");
    expect(section!.content).toContain("Strategy is implicit");
    expect(section!.content).toContain("No context brief");
    expect(section!.content).toContain("Session lifecycle disconnected");
  });

  it("has Completion Criteria section", () => {
    const section = getSection(schema, "Completion Criteria");
    expect(section).not.toBeNull();
    expect(section!.content.length).toBeGreaterThan(50);
  });

  it("has Escalation section", () => {
    const section = getSection(schema, "Escalation");
    expect(section).not.toBeNull();
    expect(section!.content).toContain("Strategy");
    expect(section!.content).toContain("human");
  });

  it("Objective mentions pipeline and development cycle", () => {
    const obj = getSection(schema, "Objective");
    expect(obj).not.toBeNull();
    expect(obj!.content.toLowerCase()).toContain("pipeline");
    expect(obj!.content.toLowerCase()).toContain("development cycle");
  });

  it("Interaction Flow describes the 5-step pipeline", () => {
    const flow = getSection(schema, "Interaction Flow");
    expect(flow).not.toBeNull();
    expect(flow!.content).toContain("Research phase");
    expect(flow!.content).toContain("Implementation phase");
    expect(flow!.content).toContain("Review phase");
    expect(flow!.content).toContain("Iteration");
    expect(flow!.content).toContain("Architecture escalation");
  });

  it("Agent Roles section describes all four agents", () => {
    const roles = getSection(schema, "Agent Roles");
    expect(roles).not.toBeNull();
    for (const name of ["dev", "research", "critic", "strategy"]) {
      expect(roles!.content).toContain(name);
    }
  });

  it("has all expected section headings", () => {
    const headings = listSectionHeadings(schema);
    expect(headings).toContain("Objective");
    expect(headings).toContain("Agent Roles");
    expect(headings).toContain("Interaction Flow");
    expect(headings).toContain("Completion Criteria");
    expect(headings).toContain("Session Integration");
    expect(headings).toContain("Current Gaps");
    expect(headings).toContain("Escalation");
  });
});

// ── Orchestration ───────────────────────────────────────────────

describe("software-development formation — orchestration", () => {
  beforeEach(() => {
    _resetIdCounter();
  });

  it("can be invoked via orchestrator with pipeline protocol", async () => {
    const deps = makeOrchestratorDeps({
      research: "Context brief: relay.ts has 4400+ lines. Formation types are in src/types/formation.ts. Existing pattern uses injectable deps. Forest has 3 prior decisions on this area.",
      dev: "Implementation complete. Added FormationLoader class with SKILL.md hot-reload support. Tests written: 12 unit tests covering load, validate, and cache invalidation.",
      critic: "Review: APPROVED. Code follows existing injectable pattern. Test coverage adequate. One minor suggestion: add a timeout to the file watcher. No security concerns.",
      strategy: "Architecture note: The loader should use the same stale-while-revalidate pattern as River docs. This keeps the formation system consistent with existing caching strategy.",
    });

    const result = await invokeFormation(deps, "software-development", "Implement formation hot-reload for SKILL.md files");
    expect(result.success).toBe(true);
    expect(result.formationName).toBe("software-development");
    expect(result.agentOutputs.length).toBe(4);
    expect(result.roundsExecuted).toBe(4);
  });

  it("pipeline runs agents in turnOrder sequence", async () => {
    const callOrder: string[] = [];
    const deps: OrchestratorDeps = {
      protocolDeps: _makeMockProtocolDeps(),
      callAgent: async (agentName: string, prompt: string) => {
        callOrder.push(agentName);
        return `[${agentName}] Done.`;
      },
      loadFormation: _makeMockFormationLoader({ "software-development": loadRaw() }),
    };

    const result = await invokeFormation(deps, "software-development", "Fix the login bug");
    expect(result.success).toBe(true);
    expect(callOrder).toEqual(["research", "dev", "critic", "strategy"]);
  });

  it("each agent receives prior messages in their prompt", async () => {
    const prompts: Record<string, string> = {};
    const deps: OrchestratorDeps = {
      protocolDeps: _makeMockProtocolDeps(),
      callAgent: async (agentName: string, prompt: string) => {
        prompts[agentName] = prompt;
        return `[${agentName}] Analysis complete.`;
      },
      loadFormation: _makeMockFormationLoader({ "software-development": loadRaw() }),
    };

    await invokeFormation(deps, "software-development", "Add dark mode");

    // Research goes first — may have empty prior-discussion tags but no agent messages
    expect(prompts.research).not.toContain('from="research"');
    expect(prompts.research).not.toContain('from="dev"');

    // Dev should see research's output
    expect(prompts.dev).toContain("prior-discussion");
    expect(prompts.dev).toContain('from="research"');

    // Critic should see research + dev output
    expect(prompts.critic).toContain("prior-discussion");
    expect(prompts.critic).toContain("dev");

    // Strategy should see all prior messages
    expect(prompts.strategy).toContain("prior-discussion");
    expect(prompts.strategy).toContain("critic");
  });

  it("handles agent failure gracefully", async () => {
    const deps: OrchestratorDeps = {
      protocolDeps: _makeMockProtocolDeps(),
      callAgent: _makeMockAgentCallFnWithErrors(["critic"], {
        research: "Context gathered.",
        dev: "Implementation done.",
        strategy: "Architecture looks good.",
      }),
      loadFormation: _makeMockFormationLoader({ "software-development": loadRaw() }),
    };

    const result = await invokeFormation(deps, "software-development", "Refactor the parser");
    expect(result.success).toBe(true);
    const criticOutput = result.agentOutputs.find(o => o.agent === "critic");
    expect(criticOutput).toBeDefined();
    expect(criticOutput!.content).toContain("error");
  });

  it("buildAgentFormationPrompt includes formation context for each agent", () => {
    const schema = parseFormation(loadRaw())!;
    const fm = schema.frontmatter;

    for (const agent of fm.agents) {
      const prompt = buildAgentFormationPrompt(agent, fm, "Build the feature", []);
      expect(prompt).toContain('name="software-development"');
      expect(prompt).toContain(agent.agent);
      expect(prompt).toContain(agent.role);
      expect(prompt).toContain(agent.responsibility);
      expect(prompt).toContain("Build the feature");
    }
  });

  it("buildSynthesisPrompt includes all agent contributions", () => {
    const schema = parseFormation(loadRaw())!;
    const outputs = schema.frontmatter.agents.map((a, i) => ({
      agent: a.agent,
      role: a.role,
      content: `Output from ${a.agent}`,
      roundNumber: i,
    }));

    const prompt = buildSynthesisPrompt(schema.frontmatter, "Build the feature", outputs);
    expect(prompt).toContain("software-development");
    expect(prompt).toContain("Build the feature");
    for (const agent of schema.frontmatter.agents) {
      expect(prompt).toContain(agent.agent);
      expect(prompt).toContain(`Output from ${agent.agent}`);
    }
  });

  it("dev is coordinator so pipeline synthesis uses last agent output (strategy)", async () => {
    const deps = makeOrchestratorDeps({
      research: "Research done.",
      dev: "Code written.",
      critic: "Approved.",
      strategy: "Final architecture recommendation: use event-driven pattern.",
    });

    const result = await invokeFormation(deps, "software-development", "Design the event system");
    expect(result.success).toBe(true);
    // Pipeline with coordinator in turnOrder: last agent's output is the synthesis
    expect(result.synthesis).toContain("Final architecture recommendation");
  });
});

// ── E2E ─────────────────────────────────────────────────────────

describe("software-development formation — E2E", () => {
  beforeEach(() => {
    _resetIdCounter();
  });

  it("full pipeline execution with realistic agent responses", async () => {
    const deps = makeOrchestratorDeps({
      research: [
        "## Context Brief",
        "- Ticket: ELLIE-677 — software-development formation",
        "- Codebase: Formation types in src/types/formation.ts (619 lines)",
        "- Pattern: SKILL.md with YAML frontmatter + markdown body",
        "- Prior decisions: Use injectable deps pattern (ELLIE-674)",
        "- Conventions: Tests in tests/, mock helpers prefixed with _makeMock",
        "- Related: ELLIE-676 created think-tank, boardroom, vrbo-ops formations",
      ].join("\n"),
      dev: [
        "## Implementation",
        "Created skills/formations/software-development/SKILL.md with:",
        "- 4 agents: dev (implementer), research (scout), critic (reviewer), strategy (architect)",
        "- Pipeline protocol: research → dev → critic → strategy",
        "- 7 sections including Session Integration and Current Gaps",
        "",
        "## Tests",
        "Created tests/formation-software-development.test.ts with 40+ tests covering:",
        "- Parsing and validation",
        "- Agent roles and protocol configuration",
        "- Section content verification",
        "- Orchestration invocation",
      ].join("\n"),
      critic: [
        "## Review: APPROVED",
        "Strengths:",
        "- Follows existing formation SKILL.md conventions from ELLIE-676",
        "- Pipeline protocol correctly models the real dev workflow",
        "- Current Gaps section adds valuable documentation",
        "- Session Integration maps to existing work session API",
        "",
        "Minor notes:",
        "- Consider adding a 'Definition of Done' section in future iterations",
        "- The critic-loop (iterate until passing) is documented but depends on pipeline re-entry which isn't yet implemented in the orchestrator",
      ].join("\n"),
      strategy: [
        "## Architecture Note",
        "The software-development formation correctly captures the current workflow.",
        "Key gap to address in future tickets:",
        "- Pipeline re-entry (critic sends back to dev) needs orchestrator support",
        "- This is a new protocol feature, not a formation issue",
        "Recommendation: Ship this formation as-is, track re-entry as a separate ticket.",
      ].join("\n"),
    });

    const result = await invokeFormation(deps, "software-development", "Implement the software-development formation for ELLIE-677");
    expect(result.success).toBe(true);
    expect(result.formationName).toBe("software-development");
    expect(result.agentOutputs).toHaveLength(4);
    expect(result.roundsExecuted).toBe(4);
    expect(result.sessionId).toBeTruthy();

    // Verify each agent contributed
    const agents = result.agentOutputs.map(o => o.agent);
    expect(agents).toContain("research");
    expect(agents).toContain("dev");
    expect(agents).toContain("critic");
    expect(agents).toContain("strategy");

    // Verify pipeline order preserved in roundNumber
    const researchRound = result.agentOutputs.find(o => o.agent === "research")!.roundNumber;
    const devRound = result.agentOutputs.find(o => o.agent === "dev")!.roundNumber;
    const criticRound = result.agentOutputs.find(o => o.agent === "critic")!.roundNumber;
    const strategyRound = result.agentOutputs.find(o => o.agent === "strategy")!.roundNumber;
    expect(researchRound).toBeLessThan(devRound);
    expect(devRound).toBeLessThan(criticRound);
    expect(criticRound).toBeLessThan(strategyRound);
  });
});
