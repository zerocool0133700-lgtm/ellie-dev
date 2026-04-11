/**
 * Formation All Agents Fail Test — ELLIE-XXX
 *
 * Verifies that when all agents in a formation fail, the formation is marked
 * as unsuccessful (success: false), not successful.
 *
 * Covers all three protocol patterns:
 * - coordinator/fan-out
 * - debate
 * - pipeline
 */

import { test, expect, beforeEach } from "bun:test";
import {
  invokeFormation,
  _makeMockAgentCallFnWithErrors,
  _makeMockFormationLoader,
  _makeMockFormationSkillMd,
  type OrchestratorDeps,
} from "../src/formations/orchestrator.ts";
import {
  _makeMockDeps as _makeMockProtocolDeps,
  _resetIdCounter,
} from "../src/formations/protocol.ts";

function makeDeps(opts: {
  errorAgents?: string[];
  agentResponses?: Record<string, string>;
  formations?: Record<string, string>;
} = {}): OrchestratorDeps & { protocolDeps: ReturnType<typeof _makeMockProtocolDeps> } {
  const protocolDeps = _makeMockProtocolDeps();
  const callAgent = opts.errorAgents
    ? _makeMockAgentCallFnWithErrors(opts.errorAgents, opts.agentResponses)
    : _makeMockAgentCallFnWithErrors([], opts.agentResponses);
  const loadFormation = _makeMockFormationLoader(opts.formations);

  return { protocolDeps, callAgent, loadFormation };
}

beforeEach(() => {
  _resetIdCounter();
});

// ── Fan-Out Protocol ────────────────────────────────────────────

test("fan-out: all agents fail → success: false", async () => {
  const md = _makeMockFormationSkillMd({
    name: "test-fanout",
    agents: [
      { agent: "dev", role: "coordinator", responsibility: "Coordinate" },
      { agent: "critic", role: "reviewer", responsibility: "Review" },
      { agent: "research", role: "researcher", responsibility: "Research" },
    ],
    protocol: {
      pattern: "coordinator",
      maxTurns: 10,
      coordinator: "dev",
      requiresApproval: false,
    },
  });

  const deps = makeDeps({
    formations: { "test-fanout": md },
    errorAgents: ["critic", "research"], // All roster agents fail (dev is coordinator)
    agentResponses: { dev: "I tried to synthesize but all agents failed." },
  });

  const result = await invokeFormation(deps, "test-fanout", "Test prompt");

  expect(result.success).toBe(false);
  expect(result.agentOutputs.length).toBe(2); // critic + research
  expect(result.agentOutputs.every(o => o.content.startsWith("[Agent error:"))).toBe(true);
});

test("fan-out: partial failure → success: true", async () => {
  const md = _makeMockFormationSkillMd({
    name: "test-fanout-partial",
    agents: [
      { agent: "dev", role: "coordinator", responsibility: "Coordinate" },
      { agent: "critic", role: "reviewer", responsibility: "Review" },
      { agent: "research", role: "researcher", responsibility: "Research" },
    ],
    protocol: {
      pattern: "coordinator",
      maxTurns: 10,
      coordinator: "dev",
      requiresApproval: false,
    },
  });

  const deps = makeDeps({
    formations: { "test-fanout-partial": md },
    errorAgents: ["critic"], // Only one agent fails
    agentResponses: {
      dev: "I synthesize.",
      research: "Research results here.",
    },
  });

  const result = await invokeFormation(deps, "test-fanout-partial", "Test prompt");

  expect(result.success).toBe(true); // At least one agent succeeded
  expect(result.agentOutputs.some(o => o.content.startsWith("[Agent error:"))).toBe(true);
  expect(result.agentOutputs.some(o => !o.content.startsWith("[Agent error:"))).toBe(true);
});

// ── Debate Protocol ─────────────────────────────────────────────

test("debate: all agents fail → success: false", async () => {
  const md = _makeMockFormationSkillMd({
    name: "test-debate",
    agents: [
      { agent: "dev", role: "coordinator", responsibility: "Coordinate" },
      { agent: "critic", role: "reviewer", responsibility: "Review" },
    ],
    protocol: {
      pattern: "debate",
      maxTurns: 2,
      coordinator: "dev",
      requiresApproval: false,
    },
  });

  const deps = makeDeps({
    formations: { "test-debate": md },
    errorAgents: ["critic"], // Only roster agent fails (dev is facilitator)
    agentResponses: { dev: "Synthesis attempt." },
  });

  const result = await invokeFormation(deps, "test-debate", "Test prompt");

  expect(result.success).toBe(false);
  expect(result.agentOutputs.every(o => o.content.startsWith("[Agent error:"))).toBe(true);
});

// ── Pipeline Protocol ───────────────────────────────────────────

test("pipeline: all agents fail → success: false", async () => {
  const md = _makeMockFormationSkillMd({
    name: "test-pipeline",
    agents: [
      { agent: "research", role: "researcher", responsibility: "Research" },
      { agent: "dev", role: "developer", responsibility: "Implement" },
      { agent: "critic", role: "reviewer", responsibility: "Review" },
    ],
    protocol: {
      pattern: "pipeline",
      maxTurns: 10,
      turnOrder: ["research", "dev", "critic"],
      requiresApproval: false,
    },
  });

  const deps = makeDeps({
    formations: { "test-pipeline": md },
    errorAgents: ["research", "dev", "critic"], // All agents fail
  });

  const result = await invokeFormation(deps, "test-pipeline", "Test prompt");

  expect(result.success).toBe(false);
  expect(result.agentOutputs.length).toBe(3);
  expect(result.agentOutputs.every(o => o.content.startsWith("[Agent error:"))).toBe(true);
});

test("pipeline: partial failure → success: true", async () => {
  const md = _makeMockFormationSkillMd({
    name: "test-pipeline-partial",
    agents: [
      { agent: "research", role: "researcher", responsibility: "Research" },
      { agent: "dev", role: "developer", responsibility: "Implement" },
      { agent: "critic", role: "reviewer", responsibility: "Review" },
    ],
    protocol: {
      pattern: "pipeline",
      maxTurns: 10,
      turnOrder: ["research", "dev", "critic"],
      requiresApproval: false,
    },
  });

  const deps = makeDeps({
    formations: { "test-pipeline-partial": md },
    errorAgents: ["dev"], // Only middle agent fails
    agentResponses: {
      research: "Research done.",
      critic: "Review complete.",
    },
  });

  const result = await invokeFormation(deps, "test-pipeline-partial", "Test prompt");

  expect(result.success).toBe(true); // At least one agent succeeded
  expect(result.agentOutputs.some(o => o.content.startsWith("[Agent error:"))).toBe(true);
  expect(result.agentOutputs.some(o => !o.content.startsWith("[Agent error:"))).toBe(true);
});

// ── Edge Cases ──────────────────────────────────────────────────

test("formation with no roster agents → success: true", async () => {
  // Single-agent formation (coordinator only)
  const md = _makeMockFormationSkillMd({
    name: "test-solo",
    agents: [
      { agent: "dev", role: "coordinator", responsibility: "Do everything" },
    ],
    protocol: {
      pattern: "coordinator",
      maxTurns: 10,
      coordinator: "dev",
      requiresApproval: false,
    },
  });

  const deps = makeDeps({
    formations: { "test-solo": md },
    agentResponses: { dev: "Solo synthesis." },
  });

  const result = await invokeFormation(deps, "test-solo", "Test prompt");

  // No roster agents executed, so agentOutputs is empty — this is not a failure
  expect(result.success).toBe(true);
  expect(result.agentOutputs.length).toBe(0);
  expect(result.synthesis).toContain("Solo synthesis");
});
