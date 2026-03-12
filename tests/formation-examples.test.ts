/**
 * Formation Examples Tests — ELLIE-676
 *
 * Validates the three example formation SKILL.md files:
 *   - think-tank (fan-out / coordinator)
 *   - boardroom (debate)
 *   - vrbo-ops (coordinator / delegation)
 *
 * Tests cover:
 *   - Parsing: each SKILL.md parses into a valid FormationSchema
 *   - Validation: each passes validateFormation() with zero errors
 *   - Structure: correct agents, protocol, triggers, sections
 *   - Orchestration: each can be invoked via the orchestrator mock system
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
  _makeMockFormationLoader,
  type OrchestratorDeps,
} from "../src/formations/orchestrator.ts";

import {
  _makeMockDeps as _makeMockProtocolDeps,
  _resetIdCounter,
} from "../src/formations/protocol.ts";

// ── Helpers ─────────────────────────────────────────────────────

const FORMATIONS_DIR = join(import.meta.dir, "../skills/formations");

function loadFormation(slug: string): string {
  return readFileSync(join(FORMATIONS_DIR, slug, "SKILL.md"), "utf-8");
}

function makeOrchestratorDeps(formations: Record<string, string>, responses?: Record<string, string>): OrchestratorDeps {
  return {
    protocolDeps: _makeMockProtocolDeps(),
    callAgent: _makeMockAgentCallFn(responses),
    loadFormation: _makeMockFormationLoader(formations),
  };
}

// ── Think Tank ──────────────────────────────────────────────────

describe("think-tank formation", () => {
  let raw: string;
  let schema: FormationSchema;

  beforeEach(() => {
    _resetIdCounter();
    raw = loadFormation("think-tank");
    schema = parseFormation(raw)!;
  });

  it("parses successfully", () => {
    expect(schema).not.toBeNull();
    expect(schema.frontmatter.name).toBe("think-tank");
  });

  it("validates with zero errors", () => {
    const result = validateFormation(schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("has correct agents", () => {
    const names = getAgentNames(schema);
    expect(names).toEqual(["research", "strategy", "critic"]);
  });

  it("uses coordinator pattern with strategy as coordinator", () => {
    expect(schema.frontmatter.protocol.pattern).toBe("coordinator");
    expect(schema.frontmatter.protocol.coordinator).toBe("strategy");
    expect(schema.frontmatter.protocol.maxTurns).toBe(6);
  });

  it("has correct conflict resolution", () => {
    expect(schema.frontmatter.protocol.conflictResolution).toBe("coordinator-decides");
  });

  it("has triggers", () => {
    expect(schema.frontmatter.triggers).toBeDefined();
    expect(schema.frontmatter.triggers!.length).toBeGreaterThanOrEqual(2);
    expect(schema.frontmatter.triggers).toContain("think tank");
  });

  it("has minAgents = 3", () => {
    expect(schema.frontmatter.minAgents).toBe(3);
  });

  it("has timeoutSeconds = 300", () => {
    expect(schema.frontmatter.timeoutSeconds).toBe(300);
  });

  it("has all required sections", () => {
    expect(hasAllRequiredSections(schema)).toBe(true);
  });

  it("has Completion Criteria and Escalation sections", () => {
    const headings = listSectionHeadings(schema);
    expect(headings).toContain("Completion Criteria");
    expect(headings).toContain("Escalation");
  });

  it("Objective section mentions options matrix", () => {
    const obj = getSection(schema, "Objective");
    expect(obj).not.toBeNull();
    expect(obj!.content.toLowerCase()).toContain("options matrix");
  });

  it("agent roles describe all three agents", () => {
    const roles = getSection(schema, "Agent Roles");
    expect(roles).not.toBeNull();
    expect(roles!.content).toContain("research");
    expect(roles!.content).toContain("strategy");
    expect(roles!.content).toContain("critic");
  });

  it("each agent has a responsibility", () => {
    for (const agent of schema.frontmatter.agents) {
      expect(agent.responsibility.length).toBeGreaterThan(10);
    }
  });

  it("validateFormationFile round-trips correctly", () => {
    const result = validateFormationFile(raw);
    expect(result.schema).not.toBeNull();
    expect(result.validation.valid).toBe(true);
  });

  it("can be invoked via orchestrator", async () => {
    const deps = makeOrchestratorDeps({ "think-tank": raw }, {
      research: "Found 5 relevant case studies and 3 comparable approaches.",
      critic: "Key risk: approach A has a single point of failure. Approach B lacks scalability evidence.",
      strategy: "Options Matrix:\n| Option | Pros | Cons | Risk |\n|--------|------|------|------|\n| A | Fast | Fragile | High |\n| B | Robust | Slow | Low |\nRecommendation: Option B with phased rollout.",
    });

    const result = await invokeFormation(deps, "think-tank", "What's the best way to structure our data pipeline?");
    expect(result.success).toBe(true);
    expect(result.formationName).toBe("think-tank");
    expect(result.agentOutputs.length).toBeGreaterThanOrEqual(2);
    expect(result.synthesis.length).toBeGreaterThan(0);
    expect(result.roundsExecuted).toBeGreaterThanOrEqual(1);
  });
});

// ── Boardroom ───────────────────────────────────────────────────

describe("boardroom formation", () => {
  let raw: string;
  let schema: FormationSchema;

  beforeEach(() => {
    _resetIdCounter();
    raw = loadFormation("boardroom");
    schema = parseFormation(raw)!;
  });

  it("parses successfully", () => {
    expect(schema).not.toBeNull();
    expect(schema.frontmatter.name).toBe("boardroom");
  });

  it("validates with zero errors", () => {
    const result = validateFormation(schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("has all 6 specialist agents", () => {
    const names = getAgentNames(schema);
    expect(names).toHaveLength(6);
    expect(names).toContain("research");
    expect(names).toContain("strategy");
    expect(names).toContain("critic");
    expect(names).toContain("finance");
    expect(names).toContain("content");
    expect(names).toContain("dev");
  });

  it("uses debate pattern with strategy as coordinator", () => {
    expect(schema.frontmatter.protocol.pattern).toBe("debate");
    expect(schema.frontmatter.protocol.coordinator).toBe("strategy");
    expect(schema.frontmatter.protocol.maxTurns).toBe(12);
  });

  it("uses majority-vote conflict resolution", () => {
    expect(schema.frontmatter.protocol.conflictResolution).toBe("majority-vote");
  });

  it("has triggers", () => {
    expect(schema.frontmatter.triggers).toBeDefined();
    expect(schema.frontmatter.triggers).toContain("boardroom");
  });

  it("has minAgents = 4", () => {
    expect(schema.frontmatter.minAgents).toBe(4);
  });

  it("has timeoutSeconds = 600", () => {
    expect(schema.frontmatter.timeoutSeconds).toBe(600);
  });

  it("has all required sections", () => {
    expect(hasAllRequiredSections(schema)).toBe(true);
  });

  it("has Completion Criteria and Escalation sections", () => {
    const headings = listSectionHeadings(schema);
    expect(headings).toContain("Completion Criteria");
    expect(headings).toContain("Escalation");
  });

  it("Objective mentions decision record and dissenting opinions", () => {
    const obj = getSection(schema, "Objective");
    expect(obj).not.toBeNull();
    expect(obj!.content.toLowerCase()).toContain("decision record");
    expect(obj!.content.toLowerCase()).toContain("dissenting");
  });

  it("agent roles describe all six agents", () => {
    const roles = getSection(schema, "Agent Roles");
    expect(roles).not.toBeNull();
    for (const name of ["research", "strategy", "critic", "finance", "content", "dev"]) {
      expect(roles!.content).toContain(name);
    }
  });

  it("each agent has a unique role", () => {
    const roles = schema.frontmatter.agents.map(a => a.role);
    const unique = new Set(roles);
    expect(unique.size).toBe(roles.length);
  });

  it("each agent has canInitiate = true", () => {
    for (const agent of schema.frontmatter.agents) {
      expect(agent.canInitiate).toBe(true);
    }
  });

  it("validateFormationFile round-trips correctly", () => {
    const result = validateFormationFile(raw);
    expect(result.schema).not.toBeNull();
    expect(result.validation.valid).toBe(true);
  });

  it("can be invoked via orchestrator (debate protocol)", async () => {
    const deps = makeOrchestratorDeps({ boardroom: raw }, {
      research: "Market data shows 15% growth in this segment.",
      critic: "The growth projection assumes no new competitors. That's risky.",
      finance: "ROI analysis: break-even in 8 months at current burn rate.",
      content: "User messaging should emphasize reliability over speed.",
      dev: "Technical feasibility is high. 2-sprint estimate for MVP.",
      strategy: "Decision Record:\n- Approved: Proceed with MVP\n- Dissent: Critic flagged competitor risk\n- Action: Monthly competitor review added to ops cadence.",
    });

    const result = await invokeFormation(deps, "boardroom", "Should we enter the enterprise market?");
    expect(result.success).toBe(true);
    expect(result.formationName).toBe("boardroom");
    expect(result.agentOutputs.length).toBeGreaterThanOrEqual(5);
    expect(result.synthesis.length).toBeGreaterThan(0);
    expect(result.roundsExecuted).toBeGreaterThanOrEqual(2);
  });
});

// ── VRBO Ops ────────────────────────────────────────────────────

describe("vrbo-ops formation", () => {
  let raw: string;
  let schema: FormationSchema;

  beforeEach(() => {
    _resetIdCounter();
    raw = loadFormation("vrbo-ops");
    schema = parseFormation(raw)!;
  });

  it("parses successfully", () => {
    expect(schema).not.toBeNull();
    expect(schema.frontmatter.name).toBe("vrbo-ops");
  });

  it("validates with zero errors", () => {
    const result = validateFormation(schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("has 5 agents including vrbo domain specialist", () => {
    const names = getAgentNames(schema);
    expect(names).toHaveLength(5);
    expect(names).toContain("finance");
    expect(names).toContain("content");
    expect(names).toContain("research");
    expect(names).toContain("strategy");
    expect(names).toContain("vrbo");
  });

  it("uses coordinator pattern with strategy as coordinator", () => {
    expect(schema.frontmatter.protocol.pattern).toBe("coordinator");
    expect(schema.frontmatter.protocol.coordinator).toBe("strategy");
    expect(schema.frontmatter.protocol.maxTurns).toBe(10);
  });

  it("has coordinator-decides conflict resolution", () => {
    expect(schema.frontmatter.protocol.conflictResolution).toBe("coordinator-decides");
  });

  it("has VRBO-related triggers", () => {
    expect(schema.frontmatter.triggers).toBeDefined();
    expect(schema.frontmatter.triggers).toContain("vrbo");
  });

  it("has minAgents = 3", () => {
    expect(schema.frontmatter.minAgents).toBe(3);
  });

  it("has timeoutSeconds = 480", () => {
    expect(schema.frontmatter.timeoutSeconds).toBe(480);
  });

  it("has all required sections", () => {
    expect(hasAllRequiredSections(schema)).toBe(true);
  });

  it("has Completion Criteria and Escalation sections", () => {
    const headings = listSectionHeadings(schema);
    expect(headings).toContain("Completion Criteria");
    expect(headings).toContain("Escalation");
  });

  it("Objective mentions operational dashboard", () => {
    const obj = getSection(schema, "Objective");
    expect(obj).not.toBeNull();
    expect(obj!.content.toLowerCase()).toContain("operational dashboard");
  });

  it("Objective mentions delegation", () => {
    const obj = getSection(schema, "Objective");
    expect(obj).not.toBeNull();
    expect(obj!.content.toLowerCase()).toContain("delegat");
  });

  it("agent roles describe all five agents", () => {
    const roles = getSection(schema, "Agent Roles");
    expect(roles).not.toBeNull();
    for (const name of ["finance", "content", "research", "strategy", "vrbo"]) {
      expect(roles!.content).toContain(name);
    }
  });

  it("vrbo agent has domain-specialist role", () => {
    const vrbo = schema.frontmatter.agents.find(a => a.agent === "vrbo");
    expect(vrbo).toBeDefined();
    expect(vrbo!.role).toBe("domain-specialist");
  });

  it("each agent has a unique role", () => {
    const roles = schema.frontmatter.agents.map(a => a.role);
    const unique = new Set(roles);
    expect(unique.size).toBe(roles.length);
  });

  it("validateFormationFile round-trips correctly", () => {
    const result = validateFormationFile(raw);
    expect(result.schema).not.toBeNull();
    expect(result.validation.valid).toBe(true);
  });

  it("can be invoked via orchestrator", async () => {
    const deps = makeOrchestratorDeps({ "vrbo-ops": raw }, {
      finance: "Revenue: $4,200/mo. Expenses: $1,800/mo. Net margin: 57%. Pricing is 8% below market.",
      content: "Listing score: 72/100. Title needs keywords. Photos should lead with kitchen renovation.",
      research: "Comp analysis: 3 similar properties averaging $185/night. Peak season starts in 6 weeks.",
      vrbo: "2 pending reviews need responses. Calendar blocked for maintenance Mar 20-22. Guest inquiry about early check-in.",
      strategy: "Operational Dashboard:\n- P0: Respond to guest inquiry (vrbo)\n- P0: Raise nightly rate to $180 (finance)\n- P1: Update listing photos (content)\n- P1: Prep for peak season pricing (research + finance)\n- P2: Review maintenance schedule (vrbo)\nEscalation: Early check-in request needs owner decision.",
    });

    const result = await invokeFormation(deps, "vrbo-ops", "Give me a status update on the Lake House property");
    expect(result.success).toBe(true);
    expect(result.formationName).toBe("vrbo-ops");
    expect(result.agentOutputs.length).toBeGreaterThanOrEqual(4);
    expect(result.synthesis.length).toBeGreaterThan(0);
    expect(result.roundsExecuted).toBeGreaterThanOrEqual(1);
  });
});

// ── Cross-Formation Tests ───────────────────────────────────────

describe("cross-formation validation", () => {
  const slugs = ["think-tank", "boardroom", "vrbo-ops"] as const;
  const schemas = new Map<string, FormationSchema>();

  beforeEach(() => {
    for (const slug of slugs) {
      const raw = loadFormation(slug);
      const schema = parseFormation(raw);
      if (schema) schemas.set(slug, schema);
    }
  });

  it("all three formations parse successfully", () => {
    expect(schemas.size).toBe(3);
  });

  it("all three formations have unique names", () => {
    const names = [...schemas.values()].map(s => s.frontmatter.name);
    expect(new Set(names).size).toBe(3);
  });

  it("all three formations validate cleanly", () => {
    for (const [slug, schema] of schemas) {
      const result = validateFormation(schema);
      expect(result.valid).toBe(true);
      if (!result.valid) {
        console.error(`${slug} validation errors:`, result.errors);
      }
    }
  });

  it("all formations have strategy as coordinator/facilitator", () => {
    for (const [, schema] of schemas) {
      const coordinator = schema.frontmatter.protocol.coordinator;
      expect(coordinator).toBe("strategy");
    }
  });

  it("all formations have Completion Criteria sections", () => {
    for (const [, schema] of schemas) {
      const section = getSection(schema, "Completion Criteria");
      expect(section).not.toBeNull();
      expect(section!.content.length).toBeGreaterThan(20);
    }
  });

  it("all formations have Escalation sections", () => {
    for (const [, schema] of schemas) {
      const section = getSection(schema, "Escalation");
      expect(section).not.toBeNull();
      expect(section!.content.length).toBeGreaterThan(20);
    }
  });

  it("no two formations share the same trigger", () => {
    const allTriggers: string[] = [];
    for (const [, schema] of schemas) {
      if (schema.frontmatter.triggers) {
        allTriggers.push(...schema.frontmatter.triggers);
      }
    }
    expect(new Set(allTriggers).size).toBe(allTriggers.length);
  });

  it("buildAgentFormationPrompt works for each formation's agents", () => {
    for (const [, schema] of schemas) {
      for (const agent of schema.frontmatter.agents) {
        const prompt = buildAgentFormationPrompt(agent, schema.frontmatter, "Test question", []);
        expect(prompt).toContain(agent.agent);
        expect(prompt).toContain(agent.role);
        expect(prompt).toContain("Test question");
        expect(prompt).toContain(schema.frontmatter.name);
      }
    }
  });

  it("buildSynthesisPrompt works for each formation", () => {
    for (const [, schema] of schemas) {
      const outputs = schema.frontmatter.agents.map(a => ({
        agent: a.agent,
        role: a.role,
        content: `Analysis from ${a.agent}`,
        roundNumber: 0,
      }));
      const prompt = buildSynthesisPrompt(schema.frontmatter, "Test question", outputs);
      expect(prompt).toContain(schema.frontmatter.name);
      expect(prompt).toContain("Test question");
      for (const agent of schema.frontmatter.agents) {
        expect(prompt).toContain(agent.agent);
      }
    }
  });

  it("E2E: all formations can be invoked sequentially", async () => {
    _resetIdCounter();

    for (const slug of slugs) {
      const raw = loadFormation(slug);
      const deps = makeOrchestratorDeps({ [slug]: raw });
      const result = await invokeFormation(deps, slug, `Test prompt for ${slug}`);
      expect(result.success).toBe(true);
      expect(result.formationName).toBe(slug);
      expect(result.synthesis.length).toBeGreaterThan(0);
    }
  });
});
