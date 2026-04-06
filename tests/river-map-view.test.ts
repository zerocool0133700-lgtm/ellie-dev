/**
 * River Map View Tests — ELLIE-764
 *
 * Tests for enhanced inventory with edit URIs and migration progress:
 * - Inventory includes edit_uri on every doc
 * - Edit URIs are valid obsidian:// links
 * - Migration progress calculation
 * - Status filter logic
 * - Sort logic
 */

import { describe, test, expect } from "bun:test";
import {
  buildInventoryFromData,
  RIVER_DOC_REGISTRY,
} from "../src/river-inventory.ts";

const RELAY_URL = "http://localhost:3001";

// ── Inventory edit_uri ──────────────────────────────────────

describe("inventory edit_uri", () => {
  test("every doc has edit_uri", async () => {
    const res = await fetch(`${RELAY_URL}/api/river/inventory`);
    const data = await res.json();

    for (const doc of data.docs) {
      expect(doc.edit_uri).toBeDefined();
      expect(doc.edit_uri).toContain("obsidian://open");
    }
  });

  test("edit_uri contains vault name", async () => {
    const res = await fetch(`${RELAY_URL}/api/river/inventory`);
    const data = await res.json();

    for (const doc of data.docs) {
      expect(doc.edit_uri).toContain("vault=obsidian-vault");
    }
  });

  test("edit_uri contains ellie-river path", async () => {
    const res = await fetch(`${RELAY_URL}/api/river/inventory`);
    const data = await res.json();

    for (const doc of data.docs) {
      expect(decodeURIComponent(doc.edit_uri)).toContain("ellie-river");
    }
  });
});

// ── Migration Progress (Pure) ───────────────────────────────

describe("migration progress calculation", () => {
  test("100% when all wired", () => {
    const cache: Record<string, string | null> = {};
    for (const { key } of RIVER_DOC_REGISTRY) cache[key] = `Content for ${key}`;

    const inv = buildInventoryFromData(cache, {});
    const percent = Math.round((inv.summary.wired / inv.total) * 100);
    expect(percent).toBe(100);
  });

  test("0% when none wired", () => {
    const inv = buildInventoryFromData({}, {});
    const percent = Math.round((inv.summary.wired / inv.total) * 100);
    expect(percent).toBe(0);
  });

  test("partial progress calculated correctly", () => {
    const inv = buildInventoryFromData(
      { "soul": "content", "memory-protocol": "content" },
      {},
    );
    const percent = Math.round((inv.summary.wired / inv.total) * 100);
    expect(percent).toBe(18); // 2 out of 11
  });
});

// ── Status Filter Logic (Pure) ──────────────────────────────

describe("status filtering", () => {
  test("filter by wired returns only wired docs", () => {
    const inv = buildInventoryFromData(
      { "soul": "content", "memory-protocol": "content" },
      { "soul": true, "memory-protocol": true, "confirm-protocol": true },
    );

    const wired = inv.docs.filter(d => d.status === "wired");
    const draft = inv.docs.filter(d => d.status === "draft");
    const missing = inv.docs.filter(d => d.status === "missing");

    expect(wired).toHaveLength(2);
    expect(draft).toHaveLength(1);
    expect(missing).toHaveLength(8);
  });

  test("all filter returns all docs", () => {
    const inv = buildInventoryFromData({}, {});
    expect(inv.docs).toHaveLength(11);
  });
});

// ── Sort Logic (Pure) ───────────────────────────────────────

describe("sort logic", () => {
  test("sort by name alphabetically", () => {
    const inv = buildInventoryFromData({}, {});
    const sorted = [...inv.docs].sort((a, b) => a.key.localeCompare(b.key));
    expect(sorted[0].key).toBe("commitment-framework");
    expect(sorted[sorted.length - 1].key).toBe("work-commands");
  });

  test("sort by tokens descending", () => {
    const inv = buildInventoryFromData(
      { "soul": "x".repeat(1000), "memory-protocol": "x".repeat(200) },
      {},
    );
    const sorted = [...inv.docs].sort((a, b) => b.tokens - a.tokens);
    expect(sorted[0].key).toBe("soul");
    expect(sorted[0].tokens).toBeGreaterThan(sorted[1].tokens);
  });

  test("sort by status groups docs", () => {
    const inv = buildInventoryFromData(
      { "soul": "content" },
      { "memory-protocol": true },
    );
    const sorted = [...inv.docs].sort((a, b) => a.status.localeCompare(b.status));
    // draft < missing < wired alphabetically
    expect(sorted[0].status).toBe("draft");
  });
});

// ── Live API Verification ───────────────────────────────────

describe("live inventory API", () => {
  test("returns valid inventory with all fields", async () => {
    const res = await fetch(`${RELAY_URL}/api/river/inventory`);
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.total).toBe(11);
    expect(data.docs).toHaveLength(11);
    expect(data.summary.wired + data.summary.draft + data.summary.missing + data.summary.hardcoded).toBe(11);

    for (const doc of data.docs) {
      expect(doc.key).toBeTruthy();
      expect(doc.path).toMatch(/^river\//);
      expect(doc.edit_uri).toContain("obsidian://");
      expect(doc.used_by_agents.length).toBeGreaterThan(0);
    }
  });
});
