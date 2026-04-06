/**
 * River Inventory Tests — ELLIE-760
 *
 * Tests for River document inventory:
 * - Registry completeness
 * - Agent mapping
 * - Status classification (wired/draft/missing)
 * - Summary counts
 * - Inventory from data (pure function)
 * - Response shape contract
 */

import { describe, test, expect } from "bun:test";
import {
  buildInventoryFromData,
  RIVER_DOC_REGISTRY,
  DOC_AGENT_MAP,
  type RiverDocEntry,
  type RiverInventoryResult,
  type RiverDocStatus,
} from "../src/river-inventory.ts";

// ── Registry ────────────────────────────────────────────────

describe("RIVER_DOC_REGISTRY", () => {
  test("has all 11 known River doc keys", () => {
    expect(RIVER_DOC_REGISTRY).toHaveLength(11);
    const keys = RIVER_DOC_REGISTRY.map(d => d.key);
    expect(keys).toContain("soul");
    expect(keys).toContain("memory-protocol");
    expect(keys).toContain("confirm-protocol");
    expect(keys).toContain("forest-writes");
    expect(keys).toContain("dev-agent-template");
    expect(keys).toContain("research-agent-template");
    expect(keys).toContain("strategy-agent-template");
    expect(keys).toContain("playbook-commands");
    expect(keys).toContain("work-commands");
    expect(keys).toContain("planning-mode");
    expect(keys).toContain("commitment-framework");
  });

  test("all paths are .md files", () => {
    for (const doc of RIVER_DOC_REGISTRY) {
      expect(doc.path).toMatch(/\.md$/);
    }
  });

  test("paths are vault-relative (no leading slash)", () => {
    for (const doc of RIVER_DOC_REGISTRY) {
      expect(doc.path).not.toMatch(/^\//);
    }
  });
});

// ── Agent Mapping ───────────────────────────────────────────

describe("DOC_AGENT_MAP", () => {
  test("soul is used by all agents", () => {
    expect(DOC_AGENT_MAP["soul"]).toContain("general");
    expect(DOC_AGENT_MAP["soul"]).toContain("dev");
    expect(DOC_AGENT_MAP["soul"]).toContain("research");
    expect(DOC_AGENT_MAP["soul"]).toContain("strategy");
    expect(DOC_AGENT_MAP["soul"].length).toBeGreaterThanOrEqual(6);
  });

  test("dev-agent-template only used by dev", () => {
    expect(DOC_AGENT_MAP["dev-agent-template"]).toEqual(["dev"]);
  });

  test("research-agent-template only used by research", () => {
    expect(DOC_AGENT_MAP["research-agent-template"]).toEqual(["research"]);
  });

  test("strategy-agent-template only used by strategy", () => {
    expect(DOC_AGENT_MAP["strategy-agent-template"]).toEqual(["strategy"]);
  });

  test("playbook-commands only used by general", () => {
    expect(DOC_AGENT_MAP["playbook-commands"]).toEqual(["general"]);
  });

  test("every registry key has an agent mapping", () => {
    for (const { key } of RIVER_DOC_REGISTRY) {
      expect(DOC_AGENT_MAP[key]).toBeDefined();
      expect(DOC_AGENT_MAP[key].length).toBeGreaterThan(0);
    }
  });
});

// ── buildInventoryFromData (Pure) ───────────────────────────

describe("buildInventoryFromData", () => {
  test("all docs wired when all cached", () => {
    const cache: Record<string, string | null> = {};
    const files: Record<string, boolean> = {};
    for (const { key } of RIVER_DOC_REGISTRY) {
      cache[key] = `Content for ${key}`;
      files[key] = true;
    }

    const inv = buildInventoryFromData(cache, files);
    expect(inv.total).toBe(11);
    expect(inv.summary.wired).toBe(11);
    expect(inv.summary.draft).toBe(0);
    expect(inv.summary.missing).toBe(0);
  });

  test("docs marked missing when no cache and no file", () => {
    const inv = buildInventoryFromData({}, {});
    expect(inv.summary.missing).toBe(11);
    expect(inv.summary.wired).toBe(0);
    expect(inv.summary.draft).toBe(0);
  });

  test("docs marked draft when file exists but not cached", () => {
    const files: Record<string, boolean> = {};
    for (const { key } of RIVER_DOC_REGISTRY) {
      files[key] = true;
    }

    const inv = buildInventoryFromData({}, files);
    expect(inv.summary.draft).toBe(11);
    expect(inv.summary.wired).toBe(0);
  });

  test("mixed status: some wired, some draft, some missing", () => {
    const cache: Record<string, string | null> = {
      "soul": "Soul content here",
      "memory-protocol": "Memory protocol content",
    };
    const files: Record<string, boolean> = {
      "soul": true,
      "memory-protocol": true,
      "confirm-protocol": true, // file exists but not cached = draft
      "forest-writes": true,    // draft
    };

    const inv = buildInventoryFromData(cache, files);
    expect(inv.summary.wired).toBe(2);
    expect(inv.summary.draft).toBe(2);
    expect(inv.summary.missing).toBe(7); // 11 - 2 wired - 2 draft

    // Verify specific statuses
    const soul = inv.docs.find(d => d.key === "soul");
    expect(soul!.status).toBe("wired");
    expect(soul!.tokens).toBeGreaterThan(0);

    const confirm = inv.docs.find(d => d.key === "confirm-protocol");
    expect(confirm!.status).toBe("draft");
    expect(confirm!.tokens).toBe(0);

    const dev = inv.docs.find(d => d.key === "dev-agent-template");
    expect(dev!.status).toBe("missing");
  });

  test("wired docs have token counts", () => {
    const inv = buildInventoryFromData(
      { "soul": "x".repeat(400) },
      { "soul": true },
    );
    const soul = inv.docs.find(d => d.key === "soul");
    expect(soul!.tokens).toBeGreaterThan(0);
  });

  test("draft and missing docs have 0 tokens", () => {
    const inv = buildInventoryFromData(
      {},
      { "soul": true },
    );
    const soul = inv.docs.find(d => d.key === "soul");
    expect(soul!.status).toBe("draft");
    expect(soul!.tokens).toBe(0);
  });

  test("paths are prefixed with river/", () => {
    const inv = buildInventoryFromData({}, {});
    for (const doc of inv.docs) {
      expect(doc.path).toMatch(/^river\//);
    }
  });

  test("used_by_agents populated from DOC_AGENT_MAP", () => {
    const inv = buildInventoryFromData({}, {});
    const soul = inv.docs.find(d => d.key === "soul");
    expect(soul!.used_by_agents).toContain("general");
    expect(soul!.used_by_agents).toContain("dev");

    const devTemplate = inv.docs.find(d => d.key === "dev-agent-template");
    expect(devTemplate!.used_by_agents).toEqual(["dev"]);
  });

  test("total equals docs.length", () => {
    const inv = buildInventoryFromData({}, {});
    expect(inv.total).toBe(inv.docs.length);
  });

  test("summary counts add up to total", () => {
    const cache: Record<string, string | null> = { "soul": "content" };
    const files: Record<string, boolean> = { "soul": true, "memory-protocol": true };
    const inv = buildInventoryFromData(cache, files);
    expect(inv.summary.wired + inv.summary.draft + inv.summary.missing + inv.summary.hardcoded).toBe(inv.total);
  });
});

// ── Response Shape Contract ─────────────────────────────────

describe("response shape contract", () => {
  test("matches ticket-specified response shape", () => {
    const inv = buildInventoryFromData(
      { "soul": "Soul content" },
      { "soul": true, "memory-protocol": true },
    );

    // Top-level fields
    expect(typeof inv.total).toBe("number");
    expect(inv.docs).toBeInstanceOf(Array);
    expect(inv.summary).toBeDefined();

    // Summary fields
    expect(typeof inv.summary.wired).toBe("number");
    expect(typeof inv.summary.draft).toBe("number");
    expect(typeof inv.summary.missing).toBe("number");
    expect(typeof inv.summary.hardcoded).toBe("number");

    // Doc entry fields
    for (const doc of inv.docs) {
      expect(typeof doc.key).toBe("string");
      expect(typeof doc.path).toBe("string");
      expect(["wired", "draft", "missing", "hardcoded"]).toContain(doc.status);
      expect(doc.used_by_agents).toBeInstanceOf(Array);
      expect(typeof doc.tokens).toBe("number");
      // last_modified can be null (from pure function) or string (from filesystem)
    }
  });

  test("all 4 status types are valid", () => {
    const statuses: RiverDocStatus[] = ["wired", "draft", "missing", "hardcoded"];
    expect(statuses).toHaveLength(4);
  });
});

// ── E2E: Realistic Inventory ────────────────────────────────

describe("E2E: realistic inventory scenario", () => {
  test("partially wired vault: 3 wired, 2 draft, 5 missing", () => {
    const inv = buildInventoryFromData(
      {
        "soul": "You are Ellie, a personal AI assistant...",
        "memory-protocol": "When you encounter information worth remembering...",
        "confirm-protocol": "Before taking irreversible actions...",
      },
      {
        "soul": true,
        "memory-protocol": true,
        "confirm-protocol": true,
        "forest-writes": true,
        "dev-agent-template": true,
      },
    );

    expect(inv.summary.wired).toBe(3);
    expect(inv.summary.draft).toBe(2);
    expect(inv.summary.missing).toBe(6);
    expect(inv.total).toBe(11);

    // Wired docs have tokens
    const wired = inv.docs.filter(d => d.status === "wired");
    expect(wired.every(d => d.tokens > 0)).toBe(true);

    // Draft docs exist on disk but aren't loaded
    const drafts = inv.docs.filter(d => d.status === "draft");
    expect(drafts.every(d => d.tokens === 0)).toBe(true);

    // Missing docs don't exist at all
    const missing = inv.docs.filter(d => d.status === "missing");
    expect(missing.every(d => d.tokens === 0)).toBe(true);

    // Agent mappings preserved
    const soul = inv.docs.find(d => d.key === "soul")!;
    expect(soul.used_by_agents.length).toBeGreaterThanOrEqual(6);
  });
});
