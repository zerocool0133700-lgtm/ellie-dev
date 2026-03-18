/**
 * Agent Presence Tests — ELLIE-846
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { updateAgentPresence } from "../src/api/channels.ts";

const RELAY_URL = "http://localhost:3001";

async function relayUp(): Promise<boolean> {
  try {
    const r = await fetch(`${RELAY_URL}/health`);
    return r.ok;
  } catch {
    return false;
  }
}

describe("Agent Presence", () => {
  let isUp = false;

  beforeAll(async () => {
    isUp = await relayUp();
    if (!isUp) console.warn("⚠ Relay not running — some presence tests will be skipped");
  });

  it("GET /api/agents/presence returns all 7 agents", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/agents/presence`);
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(data.success).toBe(true);
    expect(data.presence).toHaveLength(7);
  });

  it("each agent has a valid status", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/agents/presence`);
    const data = await res.json() as any;
    const valid = new Set(["online", "idle", "busy", "offline"]);
    for (const p of data.presence) {
      expect(valid.has(p.status)).toBe(true);
      expect(typeof p.agent_name).toBe("string");
      expect(p.last_seen).toBeDefined();
    }
  });

  it("all expected agent names are present", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/agents/presence`);
    const data = await res.json() as any;
    const names = data.presence.map((p: any) => p.agent_name).sort();
    expect(names).toEqual(["content", "critic", "dev", "general", "ops", "research", "strategy"]);
  });
});
