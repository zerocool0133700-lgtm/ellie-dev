/**
 * GTD Team Tests — ELLIE-882
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

describe("GTD Types", () => {
  it("AGENT_DISPLAY_NAMES has all 7 agents", () => {
    expect(Object.keys(AGENT_DISPLAY_NAMES)).toHaveLength(7);
    expect(AGENT_DISPLAY_NAMES.dev).toBe("James");
    expect(AGENT_DISPLAY_NAMES.general).toBe("Ellie");
    expect(AGENT_DISPLAY_NAMES.research).toBe("Kate");
    expect(AGENT_DISPLAY_NAMES.content).toBe("Amy");
    expect(AGENT_DISPLAY_NAMES.critic).toBe("Brian");
    expect(AGENT_DISPLAY_NAMES.strategy).toBe("Alan");
    expect(AGENT_DISPLAY_NAMES.ops).toBe("Jason");
  });
});

describe("GTD Team API", () => {
  let isUp = false;

  beforeAll(async () => {
    isUp = await relayUp();
    if (!isUp) console.warn("⚠ Relay not running — GTD team API tests will be skipped");
  });

  it("GET /api/gtd/team returns agent breakdown", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/gtd/team`);
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(data.success).toBe(true);
    expect(Array.isArray(data.agents)).toBe(true);
    expect(data.agents.length).toBe(7);

    // Each agent has expected fields
    for (const agent of data.agents) {
      expect(agent.agent).toBeDefined();
      expect(agent.display_name).toBeDefined();
      expect(typeof agent.open).toBe("number");
      expect(typeof agent.waiting).toBe("number");
      expect(typeof agent.done_this_week).toBe("number");
    }

    // Unassigned bucket exists
    expect(data.unassigned).toBeDefined();
    expect(typeof data.total_open).toBe("number");
  });

  it("GET /api/gtd/next-actions supports ?agent filter", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/gtd/next-actions?agent=dev`);
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(Array.isArray(data.next_actions)).toBe(true);
    // All returned actions should be assigned to dev (or empty)
    for (const action of data.next_actions) {
      expect(action.assigned_agent).toBe("dev");
    }
  });

  it("GET /api/gtd/next-actions without filter returns all", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/gtd/next-actions`);
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(Array.isArray(data.next_actions)).toBe(true);
  });

  it("POST /api/gtd/delegate validates required fields", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/gtd/delegate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/gtd/delegate/complete validates required fields", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/gtd/delegate/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/gtd/snapshots/capture creates snapshot", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/gtd/snapshots/capture`, { method: "POST" });
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(data.success).toBe(true);
    expect(data.date).toBeDefined();
    expect(Array.isArray(data.snapshots)).toBe(true);
    expect(data.snapshots.length).toBe(7);
  });

  it("GET /api/gtd/snapshots returns history", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/gtd/snapshots?days=7`);
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(data.success).toBe(true);
    expect(Array.isArray(data.snapshots)).toBe(true);
  });

  it("GET /api/gtd/reports/velocity returns weekly data", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/gtd/reports/velocity?weeks=2`);
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(data.success).toBe(true);
    expect(Array.isArray(data.velocity)).toBe(true);
  });
});
