/**
 * Agent-Doc Dependency Mapping Tests — ELLIE-761
 *
 * Tests for bidirectional agent-doc graph:
 * - Agent -> docs mapping
 * - Doc -> agents mapping
 * - Shared vs agent-specific classification
 * - Token totals per agent
 * - Helper functions
 * - Response shape contract
 */

import { describe, test, expect } from "bun:test";
import {
  buildAgentMapFromData,
  getAgentNames,
  getSharedDocs,
  getAgentSpecificDocs,
  type AgentMapResult,
} from "../src/river-agent-map.ts";
import { DOC_AGENT_MAP, RIVER_DOC_REGISTRY } from "../src/river-inventory.ts";

// ── buildAgentMapFromData (Pure) ────────────────────────────

describe("buildAgentMapFromData", () => {
  const tokenData: Record<string, number> = {
    "soul": 2400,
    "memory-protocol": 400,
    "confirm-protocol": 250,
    "forest-writes": 300,
    "dev-agent-template": 500,
    "research-agent-template": 450,
    "strategy-agent-template": 400,
    "playbook-commands": 200,
    "work-commands": 150,
    "planning-mode": 350,
  };

  test("agents side: every agent has docs list", () => {
    const map = buildAgentMapFromData(tokenData);
    expect(Object.keys(map.agents).length).toBeGreaterThanOrEqual(6);
    for (const [, profile] of Object.entries(map.agents)) {
      expect(profile.docs.length).toBeGreaterThan(0);
    }
  });

  test("agents side: dev has dev-agent-template + shared docs", () => {
    const map = buildAgentMapFromData(tokenData);
    expect(map.agents.dev.docs).toContain("dev-agent-template");
    expect(map.agents.dev.docs).toContain("soul");
    expect(map.agents.dev.docs).toContain("memory-protocol");
  });

  test("agents side: general has playbook-commands", () => {
    const map = buildAgentMapFromData(tokenData);
    expect(map.agents.general.docs).toContain("playbook-commands");
  });

  test("agents side: research does NOT have dev-agent-template", () => {
    const map = buildAgentMapFromData(tokenData);
    expect(map.agents.research.docs).not.toContain("dev-agent-template");
    expect(map.agents.research.docs).toContain("research-agent-template");
  });

  test("agents side: total_tokens sums doc tokens", () => {
    const map = buildAgentMapFromData(tokenData);
    // dev: soul(2400) + memory(400) + confirm(250) + forest(300) + dev-template(500) + work-commands(150) + planning(350) = 4350
    const devDocs = map.agents.dev.docs;
    const expectedTotal = devDocs.reduce((sum, d) => sum + (tokenData[d] ?? 0), 0);
    expect(map.agents.dev.total_tokens).toBe(expectedTotal);
  });

  test("agents side: total_tokens = 0 when no cached data", () => {
    const map = buildAgentMapFromData({});
    for (const [, profile] of Object.entries(map.agents)) {
      expect(profile.total_tokens).toBe(0);
    }
  });

  test("docs side: all 11 registry keys present", () => {
    const map = buildAgentMapFromData(tokenData);
    expect(Object.keys(map.docs)).toHaveLength(11);
    for (const { key } of RIVER_DOC_REGISTRY) {
      expect(map.docs[key]).toBeDefined();
    }
  });

  test("docs side: soul is shared (multiple agents)", () => {
    const map = buildAgentMapFromData(tokenData);
    expect(map.docs["soul"].shared).toBe(true);
    expect(map.docs["soul"].used_by.length).toBeGreaterThan(1);
  });

  test("docs side: dev-agent-template is NOT shared (single agent)", () => {
    const map = buildAgentMapFromData(tokenData);
    expect(map.docs["dev-agent-template"].shared).toBe(false);
    expect(map.docs["dev-agent-template"].used_by).toEqual(["dev"]);
  });

  test("docs side: paths are river-prefixed", () => {
    const map = buildAgentMapFromData(tokenData);
    for (const [, profile] of Object.entries(map.docs)) {
      expect(profile.path).toMatch(/^river\//);
    }
  });

  test("docs side: tokens from provided data", () => {
    const map = buildAgentMapFromData(tokenData);
    expect(map.docs["soul"].tokens).toBe(2400);
    expect(map.docs["dev-agent-template"].tokens).toBe(500);
  });
});

// ── getAgentNames ───────────────────────────────────────────

describe("getAgentNames", () => {
  test("returns all agents from DOC_AGENT_MAP sorted", () => {
    const names = getAgentNames();
    expect(names.length).toBeGreaterThanOrEqual(6);
    expect(names).toContain("general");
    expect(names).toContain("dev");
    expect(names).toContain("research");
    expect(names).toContain("strategy");
    // Sorted
    for (let i = 1; i < names.length; i++) {
      expect(names[i] >= names[i - 1]).toBe(true);
    }
  });
});

// ── getSharedDocs ───────────────────────────────────────────

describe("getSharedDocs", () => {
  test("returns docs used by multiple agents", () => {
    const map = buildAgentMapFromData({});
    const shared = getSharedDocs(map);
    expect(shared).toContain("soul");
    expect(shared).toContain("memory-protocol");
    expect(shared).toContain("confirm-protocol");
    expect(shared).not.toContain("dev-agent-template");
  });
});

// ── getAgentSpecificDocs ────────────────────────────────────

describe("getAgentSpecificDocs", () => {
  test("returns docs unique to each agent", () => {
    const map = buildAgentMapFromData({});
    const specific = getAgentSpecificDocs(map);
    expect(specific.dev).toContain("dev-agent-template");
    expect(specific.research).toContain("research-agent-template");
    expect(specific.strategy).toContain("strategy-agent-template");
    expect(specific.general).toContain("playbook-commands");
  });

  test("shared docs do NOT appear in specific", () => {
    const map = buildAgentMapFromData({});
    const specific = getAgentSpecificDocs(map);
    for (const docs of Object.values(specific)) {
      expect(docs).not.toContain("soul");
      expect(docs).not.toContain("memory-protocol");
    }
  });
});

// ── Response Shape Contract ─────────────────────────────────

describe("response shape contract", () => {
  test("matches ticket-specified response shape", () => {
    const map = buildAgentMapFromData({ "soul": 1200 });

    // agents side
    expect(map.agents).toBeDefined();
    expect(typeof map.agents).toBe("object");
    for (const [agent, profile] of Object.entries(map.agents)) {
      expect(typeof agent).toBe("string");
      expect(profile.docs).toBeInstanceOf(Array);
      expect(typeof profile.total_tokens).toBe("number");
    }

    // docs side
    expect(map.docs).toBeDefined();
    for (const [key, profile] of Object.entries(map.docs)) {
      expect(typeof key).toBe("string");
      expect(profile.used_by).toBeInstanceOf(Array);
      expect(typeof profile.shared).toBe("boolean");
      expect(typeof profile.path).toBe("string");
      expect(typeof profile.tokens).toBe("number");
    }
  });

  test("bidirectional consistency: agent lists doc AND doc lists agent", () => {
    const map = buildAgentMapFromData({});

    // For every agent -> doc, verify doc -> agent
    for (const [agent, profile] of Object.entries(map.agents)) {
      for (const docKey of profile.docs) {
        expect(map.docs[docKey].used_by).toContain(agent);
      }
    }

    // For every doc -> agent, verify agent -> doc
    for (const [docKey, profile] of Object.entries(map.docs)) {
      for (const agent of profile.used_by) {
        expect(map.agents[agent].docs).toContain(docKey);
      }
    }
  });
});
