/**
 * Billing Ops Formation Tests — ELLIE-678
 *
 * Validates the billing-ops formation SKILL.md for Office Practicum
 * medical billing agency operations.
 *
 * Tests cover:
 *   - Parsing and validation
 *   - Agent roster (finance, research, billing, strategy, critic)
 *   - Pipeline protocol with compliance audit gate
 *   - Key scenarios documentation
 *   - Orchestration invocation
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

const SKILL_PATH = join(import.meta.dir, "../skills/formations/billing-ops/SKILL.md");

function loadRaw(): string {
  return readFileSync(SKILL_PATH, "utf-8");
}

function makeOrchestratorDeps(responses?: Record<string, string>): OrchestratorDeps {
  return {
    protocolDeps: _makeMockProtocolDeps(),
    callAgent: _makeMockAgentCallFn(responses),
    loadFormation: _makeMockFormationLoader({ "billing-ops": loadRaw() }),
  };
}

// ── Parsing ─────────────────────────────────────────────────────

describe("billing-ops formation — parsing", () => {
  let raw: string;
  let schema: FormationSchema;

  beforeEach(() => {
    _resetIdCounter();
    raw = loadRaw();
    schema = parseFormation(raw)!;
  });

  it("parses successfully", () => {
    expect(schema).not.toBeNull();
    expect(schema.frontmatter.name).toBe("billing-ops");
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

  it("description mentions medical billing and Office Practicum", () => {
    const desc = schema.frontmatter.description.toLowerCase();
    expect(desc).toContain("medical billing");
    expect(desc).toContain("office practicum");
  });
});

// ── Agents ──────────────────────────────────────────────────────

describe("billing-ops formation — agents", () => {
  let schema: FormationSchema;

  beforeEach(() => {
    schema = parseFormation(loadRaw())!;
  });

  it("has 5 agents", () => {
    expect(schema.frontmatter.agents).toHaveLength(5);
  });

  it("has the correct agent names", () => {
    const names = getAgentNames(schema);
    expect(names).toEqual(["finance", "research", "strategy", "billing", "critic"]);
  });

  it("finance is the revenue-analyst", () => {
    const agent = schema.frontmatter.agents.find(a => a.agent === "finance");
    expect(agent).toBeDefined();
    expect(agent!.role).toBe("revenue-analyst");
    expect(agent!.responsibility.toLowerCase()).toContain("claims");
  });

  it("research is the payer-analyst", () => {
    const agent = schema.frontmatter.agents.find(a => a.agent === "research");
    expect(agent).toBeDefined();
    expect(agent!.role).toBe("payer-analyst");
    expect(agent!.responsibility.toLowerCase()).toContain("denial");
  });

  it("billing is the platform-specialist for Office Practicum", () => {
    const agent = schema.frontmatter.agents.find(a => a.agent === "billing");
    expect(agent).toBeDefined();
    expect(agent!.role).toBe("platform-specialist");
    expect(agent!.responsibility.toLowerCase()).toContain("office practicum");
  });

  it("strategy is the operations-director", () => {
    const agent = schema.frontmatter.agents.find(a => a.agent === "strategy");
    expect(agent).toBeDefined();
    expect(agent!.role).toBe("operations-director");
  });

  it("critic is the compliance-auditor and cannot initiate", () => {
    const agent = schema.frontmatter.agents.find(a => a.agent === "critic");
    expect(agent).toBeDefined();
    expect(agent!.role).toBe("compliance-auditor");
    expect(agent!.canInitiate).toBe(false);
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

describe("billing-ops formation — protocol", () => {
  let schema: FormationSchema;

  beforeEach(() => {
    schema = parseFormation(loadRaw())!;
  });

  it("uses pipeline pattern", () => {
    expect(schema.frontmatter.protocol.pattern).toBe("pipeline");
  });

  it("has strategy as coordinator", () => {
    expect(schema.frontmatter.protocol.coordinator).toBe("strategy");
  });

  it("has correct turnOrder: finance → research → billing → strategy → critic", () => {
    expect(schema.frontmatter.protocol.turnOrder).toEqual([
      "finance", "research", "billing", "strategy", "critic",
    ]);
  });

  it("critic is last in pipeline (compliance gate)", () => {
    const order = schema.frontmatter.protocol.turnOrder!;
    expect(order[order.length - 1]).toBe("critic");
  });

  it("has maxTurns = 10", () => {
    expect(schema.frontmatter.protocol.maxTurns).toBe(10);
  });

  it("uses coordinator-decides conflict resolution", () => {
    expect(schema.frontmatter.protocol.conflictResolution).toBe("coordinator-decides");
  });
});

// ── Configuration ───────────────────────────────────────────────

describe("billing-ops formation — config", () => {
  let schema: FormationSchema;

  beforeEach(() => {
    schema = parseFormation(loadRaw())!;
  });

  it("has billing-related triggers", () => {
    expect(schema.frontmatter.triggers).toBeDefined();
    expect(schema.frontmatter.triggers).toContain("billing ops");
    expect(schema.frontmatter.triggers).toContain("denial management");
    expect(schema.frontmatter.triggers).toContain("revenue cycle");
    expect(schema.frontmatter.triggers).toContain("office practicum");
  });

  it("has minAgents = 3", () => {
    expect(schema.frontmatter.minAgents).toBe(3);
  });

  it("has timeoutSeconds = 480", () => {
    expect(schema.frontmatter.timeoutSeconds).toBe(480);
  });
});

// ── Sections ────────────────────────────────────────────────────

describe("billing-ops formation — sections", () => {
  let schema: FormationSchema;

  beforeEach(() => {
    schema = parseFormation(loadRaw())!;
  });

  it("has all required sections", () => {
    expect(hasAllRequiredSections(schema)).toBe(true);
  });

  it("has Key Scenarios section", () => {
    const section = getSection(schema, "Key Scenarios");
    expect(section).not.toBeNull();
  });

  it("Key Scenarios covers denial management", () => {
    const section = getSection(schema, "Key Scenarios")!;
    expect(section.content.toLowerCase()).toContain("denial management");
    expect(section.content.toLowerCase()).toContain("appeal");
  });

  it("Key Scenarios covers A/R aging", () => {
    const section = getSection(schema, "Key Scenarios")!;
    expect(section.content.toLowerCase()).toContain("a/r aging");
    expect(section.content.toLowerCase()).toContain("timely filing");
  });

  it("Key Scenarios covers payer contract analysis", () => {
    const section = getSection(schema, "Key Scenarios")!;
    expect(section.content.toLowerCase()).toContain("payer contract");
    expect(section.content.toLowerCase()).toContain("reimbursement");
  });

  it("Key Scenarios covers coding compliance", () => {
    const section = getSection(schema, "Key Scenarios")!;
    expect(section.content.toLowerCase()).toContain("coding compliance");
    expect(section.content.toLowerCase()).toContain("unbundling");
  });

  it("Key Scenarios covers client reporting", () => {
    const section = getSection(schema, "Key Scenarios")!;
    expect(section.content.toLowerCase()).toContain("client reporting");
    expect(section.content.toLowerCase()).toContain("per-provider");
  });

  it("has Completion Criteria section", () => {
    const section = getSection(schema, "Completion Criteria");
    expect(section).not.toBeNull();
    expect(section!.content.toLowerCase()).toContain("compliance");
    expect(section!.content).toContain("P0/P1/P2");
  });

  it("has Escalation section mentioning compliance and human review", () => {
    const section = getSection(schema, "Escalation");
    expect(section).not.toBeNull();
    expect(section!.content.toLowerCase()).toContain("compliance");
    expect(section!.content.toLowerCase()).toContain("human");
  });

  it("Objective mentions ops dashboard and compliance audit", () => {
    const obj = getSection(schema, "Objective");
    expect(obj).not.toBeNull();
    expect(obj!.content.toLowerCase()).toContain("dashboard");
    expect(obj!.content.toLowerCase()).toContain("compliance");
  });

  it("Agent Roles describes all five agents", () => {
    const roles = getSection(schema, "Agent Roles");
    expect(roles).not.toBeNull();
    for (const name of ["finance", "research", "billing", "strategy", "critic"]) {
      expect(roles!.content).toContain(name);
    }
  });

  it("has all expected section headings", () => {
    const headings = listSectionHeadings(schema);
    expect(headings).toContain("Objective");
    expect(headings).toContain("Agent Roles");
    expect(headings).toContain("Interaction Flow");
    expect(headings).toContain("Key Scenarios");
    expect(headings).toContain("Completion Criteria");
    expect(headings).toContain("Escalation");
  });
});

// ── Orchestration ───────────────────────────────────────────────

describe("billing-ops formation — orchestration", () => {
  beforeEach(() => {
    _resetIdCounter();
  });

  it("can be invoked via orchestrator with pipeline protocol", async () => {
    const deps = makeOrchestratorDeps({
      finance: "A/R Aging Summary: $142K in 90+ day bucket across 3 clients. Denial rate: 12.3% (up 2.1% MoM). Top denial code: CO-4 (modifier required). Collection rate: 94.2%.",
      research: "Payer update: UHC changed modifier rules for 99213/99214 eff. March 1. Aetna denial rate for behavioral health up 18% industry-wide. CPT 99490 reimbursement dropped $3.20 at BCBS.",
      billing: "OP Status: 47 claims pending clearinghouse review. 12 ERA posting errors (Waystar timeout). 3 patient eligibility failures — Medicaid recertification gaps. Batch 2024-0312 held for coding review.",
      strategy: "Billing Ops Dashboard:\n- P0: Fix 12 ERA posting errors (billing) — $28K held\n- P0: Resubmit CO-4 denials with modifier (finance + billing) — $18K recovery\n- P1: Address Medicaid eligibility gaps (billing)\n- P1: Update fee schedule for CPT 99490 drop (finance)\n- P2: Client ABC trending -4% collections — schedule review\nEscalation: Batch 2024-0312 held — need human review of 3 high-risk code combinations.",
      critic: "Compliance Audit: APPROVED with 2 flags.\n1. APPROVED: ERA error fixes — standard ops, no compliance risk\n2. APPROVED: CO-4 resubmissions — verify modifier documentation exists\n3. FLAG: Batch 2024-0312 contains 99215+99490 same-day combo — potential unbundling risk. Recommend manual review before submission.\n4. FLAG: Medicaid eligibility gaps — verify timely filing won't expire during recertification. 2 accounts at 160 days.",
    });

    const result = await invokeFormation(deps, "billing-ops", "Run the weekly billing ops review");
    expect(result.success).toBe(true);
    expect(result.formationName).toBe("billing-ops");
    expect(result.agentOutputs).toHaveLength(5);
    expect(result.roundsExecuted).toBe(5);
  });

  it("pipeline runs agents in correct order", async () => {
    const callOrder: string[] = [];
    const deps: OrchestratorDeps = {
      protocolDeps: _makeMockProtocolDeps(),
      callAgent: async (agentName: string) => {
        callOrder.push(agentName);
        return `[${agentName}] Done.`;
      },
      loadFormation: _makeMockFormationLoader({ "billing-ops": loadRaw() }),
    };

    await invokeFormation(deps, "billing-ops", "Run denial review");
    expect(callOrder).toEqual(["finance", "research", "billing", "strategy", "critic"]);
  });

  it("downstream agents receive upstream context", async () => {
    const prompts: Record<string, string> = {};
    const deps: OrchestratorDeps = {
      protocolDeps: _makeMockProtocolDeps(),
      callAgent: async (agentName: string, prompt: string) => {
        prompts[agentName] = prompt;
        return `[${agentName}] Analysis: findings for ${agentName}.`;
      },
      loadFormation: _makeMockFormationLoader({ "billing-ops": loadRaw() }),
    };

    await invokeFormation(deps, "billing-ops", "Monthly review");

    // Finance is first — no upstream agent messages
    expect(prompts.finance).not.toContain('from="research"');

    // Research sees finance output
    expect(prompts.research).toContain('from="finance"');

    // Critic (last) sees all upstream outputs
    expect(prompts.critic).toContain('from="finance"');
    expect(prompts.critic).toContain('from="strategy"');
  });

  it("handles agent failure gracefully", async () => {
    const deps: OrchestratorDeps = {
      protocolDeps: _makeMockProtocolDeps(),
      callAgent: _makeMockAgentCallFnWithErrors(["billing"], {
        finance: "Revenue data ready.",
        research: "Payer analysis done.",
        strategy: "Dashboard produced.",
        critic: "Audit complete.",
      }),
      loadFormation: _makeMockFormationLoader({ "billing-ops": loadRaw() }),
    };

    const result = await invokeFormation(deps, "billing-ops", "Quick review");
    expect(result.success).toBe(true);
    const billingOutput = result.agentOutputs.find(o => o.agent === "billing");
    expect(billingOutput).toBeDefined();
    expect(billingOutput!.content).toContain("error");
  });

  it("buildAgentFormationPrompt includes billing-ops context", () => {
    const schema = parseFormation(loadRaw())!;
    for (const agent of schema.frontmatter.agents) {
      const prompt = buildAgentFormationPrompt(agent, schema.frontmatter, "Run A/R review", []);
      expect(prompt).toContain('name="billing-ops"');
      expect(prompt).toContain(agent.agent);
      expect(prompt).toContain("Run A/R review");
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
    const prompt = buildSynthesisPrompt(schema.frontmatter, "Weekly review", outputs);
    expect(prompt).toContain("billing-ops");
    for (const agent of schema.frontmatter.agents) {
      expect(prompt).toContain(agent.agent);
    }
  });
});

// ── E2E ─────────────────────────────────────────────────────────

describe("billing-ops formation — E2E", () => {
  beforeEach(() => {
    _resetIdCounter();
  });

  it("full pipeline with realistic denial management scenario", async () => {
    const deps = makeOrchestratorDeps({
      finance: "Denial Summary Q1:\n- Total denials: 847 ($312K)\n- Top codes: CO-4 (23%), CO-16 (18%), PR-96 (12%)\n- Recovery rate on appeals: 67%\n- Estimated recoverable: $209K",
      research: "Payer Analysis:\n- UHC CO-4 spike correlates with modifier policy change eff. 2/15\n- Aetna CO-16 denials match new prior auth requirement for imaging\n- PR-96 denials are patient responsibility — collection issue, not payer\n- Industry benchmark denial rate: 8-10%, we're at 12.3%",
      billing: "OP Claim Status:\n- 234 denied claims pending rework in queue\n- 89 past appeal deadline (>60 days) — $41K write-off risk\n- Clearinghouse rejection rate: 3.2% (within normal)\n- Auto-adjudication rate: 78% (target: 85%)",
      strategy: "Denial Management Dashboard:\n- P0: Rework 145 CO-4 denials with updated modifiers ($67K) — assign to billing team A\n- P0: File appeals for 47 Aetna CO-16 denials before deadline ($52K) — need prior auth docs\n- P1: Write off 89 expired appeals ($41K) — escalate to client for approval\n- P1: Implement modifier template in OP for 99213/99214 to prevent future CO-4s\n- P2: Patient collection campaign for PR-96 balance ($37K)\nEscalation: Client approval needed for $41K write-off",
      critic: "Compliance Review: APPROVED with notes\n- CO-4 rework: Verify modifier documentation in patient charts before resubmission\n- CO-16 appeals: Prior auth requirements are legitimate — need supporting clinical docs\n- Write-off: $41K exceeds single-batch threshold — requires supervisor sign-off per policy\n- No unbundling or upcoding risks detected in rework queue\n- HIPAA: Ensure PHI is redacted in any client-facing reports",
    });

    const result = await invokeFormation(deps, "billing-ops", "Run Q1 denial management review");
    expect(result.success).toBe(true);
    expect(result.formationName).toBe("billing-ops");
    expect(result.agentOutputs).toHaveLength(5);

    // Verify pipeline order
    const rounds = result.agentOutputs.map(o => ({ agent: o.agent, round: o.roundNumber }));
    expect(rounds[0].agent).toBe("finance");
    expect(rounds[1].agent).toBe("research");
    expect(rounds[2].agent).toBe("billing");
    expect(rounds[3].agent).toBe("strategy");
    expect(rounds[4].agent).toBe("critic");

    // Each round number is sequential
    for (let i = 1; i < rounds.length; i++) {
      expect(rounds[i].round).toBeGreaterThan(rounds[i - 1].round);
    }
  });
});
