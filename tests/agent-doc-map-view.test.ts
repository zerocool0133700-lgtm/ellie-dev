/**
 * Agent-Doc Dependency Map View Tests — ELLIE-765
 *
 * Tests for impact analysis and dependency matrix:
 * - Impact analysis (risk levels, affected agents)
 * - Dependency matrix building
 * - Live API dual-view support
 */

import { describe, test, expect } from "bun:test";
import {
  analyzeDocImpact,
  buildDependencyMatrix,
  buildAgentMapFromData,
  getSharedDocs,
  getAgentSpecificDocs,
} from "../src/river-agent-map.ts";

const RELAY_URL = "http://localhost:3001";

// ── analyzeDocImpact (Pure) ─────────────────────────────────

describe("analyzeDocImpact", () => {
  const map = buildAgentMapFromData({});

  test("soul has high risk (used by 5+ agents)", () => {
    const impact = analyzeDocImpact("soul", map);
    expect(impact.risk_level).toBe("high");
    expect(impact.agent_count).toBeGreaterThanOrEqual(5);
    expect(impact.warning).toContain("review all downstream");
  });

  test("dev-agent-template has low risk (single agent)", () => {
    const impact = analyzeDocImpact("dev-agent-template", map);
    expect(impact.risk_level).toBe("low");
    expect(impact.agent_count).toBe(1);
    expect(impact.affected_agents).toEqual(["dev"]);
  });

  test("work-commands has medium risk (2 agents)", () => {
    const impact = analyzeDocImpact("work-commands", map);
    expect(impact.risk_level).toBe("medium");
    expect(impact.agent_count).toBe(2);
  });

  test("unknown doc returns low risk with warning", () => {
    const impact = analyzeDocImpact("nonexistent", map);
    expect(impact.risk_level).toBe("low");
    expect(impact.agent_count).toBe(0);
    expect(impact.warning).toContain("not found");
  });

  test("affected_agents matches DOC_AGENT_MAP", () => {
    const impact = analyzeDocImpact("memory-protocol", map);
    expect(impact.affected_agents).toContain("general");
    expect(impact.affected_agents).toContain("dev");
    expect(impact.affected_agents.length).toBeGreaterThanOrEqual(6);
  });
});

// ── buildDependencyMatrix (Pure) ────────────────────────────

describe("buildDependencyMatrix", () => {
  const map = buildAgentMapFromData({});

  test("returns sorted agents and docs", () => {
    const m = buildDependencyMatrix(map);
    expect(m.agents.length).toBeGreaterThanOrEqual(6);
    expect(m.docs).toHaveLength(11);
    // Sorted
    for (let i = 1; i < m.agents.length; i++) {
      expect(m.agents[i] >= m.agents[i - 1]).toBe(true);
    }
    for (let i = 1; i < m.docs.length; i++) {
      expect(m.docs[i] >= m.docs[i - 1]).toBe(true);
    }
  });

  test("matrix dimensions match agents x docs", () => {
    const m = buildDependencyMatrix(map);
    expect(m.matrix).toHaveLength(m.agents.length);
    for (const row of m.matrix) {
      expect(row).toHaveLength(m.docs.length);
    }
  });

  test("matrix contains booleans", () => {
    const m = buildDependencyMatrix(map);
    for (const row of m.matrix) {
      for (const cell of row) {
        expect(typeof cell).toBe("boolean");
      }
    }
  });

  test("dev has true for dev-agent-template", () => {
    const m = buildDependencyMatrix(map);
    const devIdx = m.agents.indexOf("dev");
    const templateIdx = m.docs.indexOf("dev-agent-template");
    expect(m.matrix[devIdx][templateIdx]).toBe(true);
  });

  test("research does NOT have dev-agent-template", () => {
    const m = buildDependencyMatrix(map);
    const resIdx = m.agents.indexOf("research");
    const templateIdx = m.docs.indexOf("dev-agent-template");
    expect(m.matrix[resIdx][templateIdx]).toBe(false);
  });

  test("all agents have soul", () => {
    const m = buildDependencyMatrix(map);
    const soulIdx = m.docs.indexOf("soul");
    for (let i = 0; i < m.agents.length; i++) {
      expect(m.matrix[i][soulIdx]).toBe(true);
    }
  });
});

// ── Live API Verification ───────────────────────────────────

describe("live agent-map API supports dual-view", () => {
  test("agents side has docs + total_tokens for by-agent view", async () => {
    const res = await fetch(`${RELAY_URL}/api/river/agent-map`);
    const data = await res.json();

    for (const [, profile] of Object.entries(data.agents) as any) {
      expect(profile.docs).toBeInstanceOf(Array);
      expect(typeof profile.total_tokens).toBe("number");
    }
  });

  test("docs side has used_by + shared for by-doc view", async () => {
    const res = await fetch(`${RELAY_URL}/api/river/agent-map`);
    const data = await res.json();

    for (const [, profile] of Object.entries(data.docs) as any) {
      expect(profile.used_by).toBeInstanceOf(Array);
      expect(typeof profile.shared).toBe("boolean");
    }
  });

  test("shared docs identified correctly", async () => {
    const res = await fetch(`${RELAY_URL}/api/river/agent-map`);
    const data = await res.json();

    // soul should be shared
    expect(data.docs.soul.shared).toBe(true);
    // dev-agent-template should not be shared
    expect(data.docs["dev-agent-template"].shared).toBe(false);
  });
});
