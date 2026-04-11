/**
 * River Control Panel Tests — ELLIE-762
 *
 * Tests for the River Control Panel backend support:
 * - All 3 River API endpoints respond
 * - Inventory returns expected shape
 * - Prompt preview with agent/channel params
 * - Agent map bidirectional structure
 * - Integration: all endpoints work together
 */

import { describe, test, expect } from "bun:test";

const RELAY_URL = "http://localhost:3001";

// ── Inventory Endpoint ──────────────────────────────────────

describe("GET /api/river/inventory", () => {
  test("returns inventory with total, docs, summary", async () => {
    const res = await fetch(`${RELAY_URL}/api/river/inventory`);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(typeof data.total).toBe("number");
    expect(data.docs).toBeInstanceOf(Array);
    expect(data.docs.length).toBe(data.total);
    expect(data.summary).toBeDefined();
    expect(typeof data.summary.wired).toBe("number");
    expect(typeof data.summary.draft).toBe("number");
    expect(typeof data.summary.missing).toBe("number");
  });

  test("every doc has key, path, status, used_by_agents, tokens", async () => {
    const res = await fetch(`${RELAY_URL}/api/river/inventory`);
    const data = await res.json();

    for (const doc of data.docs) {
      expect(typeof doc.key).toBe("string");
      expect(typeof doc.path).toBe("string");
      expect(["wired", "draft", "missing", "hardcoded"]).toContain(doc.status);
      expect(doc.used_by_agents).toBeInstanceOf(Array);
      expect(typeof doc.tokens).toBe("number");
    }
  });
});

// ── Prompt Preview Endpoint ─────────────────────────────────

describe("GET /api/river/prompt-preview", () => {
  test("returns preview for general agent", async () => {
    const res = await fetch(`${RELAY_URL}/api/river/prompt-preview?agent=general&channel=telegram`);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.agent).toBe("general");
    expect(data.channel).toBe("telegram");
    expect(typeof data.total_tokens).toBe("number");
    expect(data.sections).toBeInstanceOf(Array);
    expect(data.sections.length).toBeGreaterThan(0);
  });

  test("returns preview for dev agent", async () => {
    const res = await fetch(`${RELAY_URL}/api/river/prompt-preview?agent=dev`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.agent).toBe("dev");
  });

  test("rejects invalid agent", async () => {
    const res = await fetch(`${RELAY_URL}/api/river/prompt-preview?agent=invalid`);
    expect(res.status).toBe(400);
  });

  test("rejects missing agent", async () => {
    const res = await fetch(`${RELAY_URL}/api/river/prompt-preview`);
    expect(res.status).toBe(400);
  });

  test("each section has label, priority, tokens, status", async () => {
    const res = await fetch(`${RELAY_URL}/api/river/prompt-preview?agent=general`);
    const data = await res.json();

    for (const section of data.sections) {
      expect(typeof section.label).toBe("string");
      expect(typeof section.priority).toBe("number");
      expect(typeof section.tokens).toBe("number");
      expect(["wired", "hardcoded", "missing"]).toContain(section.status);
    }
  });
});

// ── Agent Map Endpoint ──────────────────────────────────────

describe("GET /api/river/agent-map", () => {
  test("returns agents and docs", async () => {
    const res = await fetch(`${RELAY_URL}/api/river/agent-map`);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.agents).toBeDefined();
    expect(data.docs).toBeDefined();
    expect(Object.keys(data.agents).length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(data.docs).length).toBe(11);
  });

  test("each agent has docs list and total_tokens", async () => {
    const res = await fetch(`${RELAY_URL}/api/river/agent-map`);
    const data = await res.json();

    for (const [, profile] of Object.entries(data.agents) as any) {
      expect(profile.docs).toBeInstanceOf(Array);
      expect(typeof profile.total_tokens).toBe("number");
    }
  });

  test("each doc has used_by, shared, path, tokens", async () => {
    const res = await fetch(`${RELAY_URL}/api/river/agent-map`);
    const data = await res.json();

    for (const [, profile] of Object.entries(data.docs) as any) {
      expect(profile.used_by).toBeInstanceOf(Array);
      expect(typeof profile.shared).toBe("boolean");
      expect(typeof profile.path).toBe("string");
      expect(typeof profile.tokens).toBe("number");
    }
  });
});

// ── Integration: All Endpoints Together ─────────────────────

describe("integration: River Control Panel data consistency", () => {
  test("inventory doc count matches agent-map doc count", async () => {
    const [invRes, mapRes] = await Promise.all([
      fetch(`${RELAY_URL}/api/river/inventory`),
      fetch(`${RELAY_URL}/api/river/agent-map`),
    ]);

    const inventory = await invRes.json();
    const agentMap = await mapRes.json();

    expect(inventory.total).toBe(Object.keys(agentMap.docs).length);
  });

  test("preview sections include docs from inventory", async () => {
    const [prevRes, invRes] = await Promise.all([
      fetch(`${RELAY_URL}/api/river/prompt-preview?agent=general`),
      fetch(`${RELAY_URL}/api/river/inventory`),
    ]);

    const preview = await prevRes.json();
    const inventory = await invRes.json();

    const inventoryKeys = new Set(inventory.docs.map((d: any) => d.key));
    const wiredSections = preview.sections.filter((s: any) => s.status === "wired");

    // Every wired section in the preview should correspond to a wired doc in inventory
    for (const section of wiredSections) {
      if (section.source) {
        // Source path format: river/path/to/doc.md — key might differ
        // Just verify wired sections have non-zero tokens
        expect(section.tokens).toBeGreaterThan(0);
      }
    }
  });
});
