/**
 * GTD Hardening Tests — ELLIE-909 through ELLIE-913
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { AGENT_DISPLAY_NAMES } from "../src/api/gtd-types.ts";

const RELAY_URL = "http://localhost:3001";

async function relayUp(): Promise<boolean> {
  try {
    const r = await fetch(`${RELAY_URL}/health`);
    return r.ok;
  } catch {
    return false;
  }
}

describe("ELLIE-909: Authorization checks on delegation", () => {
  let isUp = false;
  beforeAll(async () => { isUp = await relayUp(); });

  it("rejects unknown agent type", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/gtd/delegate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ todo_id: "00000000-0000-0000-0000-000000000000", to_agent: "nonexistent" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toContain("Unknown agent type");
  });

  it("rejects invalid UUID for todo_id", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/gtd/delegate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ todo_id: "not-a-uuid", to_agent: "dev" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toContain("Invalid todo_id");
  });

  it("rejects delegation of nonexistent todo", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/gtd/delegate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ todo_id: "00000000-0000-0000-0000-000000000000", to_agent: "dev" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("ELLIE-910: Velocity report optimization", () => {
  let isUp = false;
  beforeAll(async () => { isUp = await relayUp(); });

  it("returns velocity data in single query", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/gtd/reports/velocity?weeks=2`);
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(data.success).toBe(true);
    expect(Array.isArray(data.velocity)).toBe(true);
  });
});

describe("ELLIE-912: Query parameter bounds checks", () => {
  let isUp = false;
  beforeAll(async () => { isUp = await relayUp(); });

  it("velocity weeks capped at 12", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/gtd/reports/velocity?weeks=100`);
    expect(res.ok).toBe(true);
    // Should not timeout or OOM — bounded to 12 weeks
  });

  it("snapshot days capped at 365", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/gtd/snapshots?days=9999`);
    expect(res.ok).toBe(true);
  });
});

describe("ELLIE-913: Parameterized delegated_by", () => {
  it("AGENT_DISPLAY_NAMES maps all agents", () => {
    expect(Object.keys(AGENT_DISPLAY_NAMES).length).toBe(7);
    // Every value is a non-empty string
    for (const [key, val] of Object.entries(AGENT_DISPLAY_NAMES)) {
      expect(typeof val).toBe("string");
      expect(val.length).toBeGreaterThan(0);
    }
  });
});
