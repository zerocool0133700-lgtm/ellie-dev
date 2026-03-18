/**
 * Channel API Tests — ELLIE-842
 */

import { describe, it, expect, beforeAll } from "bun:test";

const RELAY_URL = "http://localhost:3001";

// Helper: check if relay is running
async function relayUp(): Promise<boolean> {
  try {
    const r = await fetch(`${RELAY_URL}/health`);
    return r.ok;
  } catch {
    return false;
  }
}

describe("Channel API", () => {
  let isUp = false;

  beforeAll(async () => {
    isUp = await relayUp();
    if (!isUp) console.warn("⚠ Relay not running — channel API tests will be skipped");
  });

  it("GET /api/channels returns channel tree", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/channels`);
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(data.success).toBe(true);
    expect(Array.isArray(data.channels)).toBe(true);
    expect(data.channels.length).toBeGreaterThan(0);

    // Should have top-level channels
    const names = data.channels.map((c: any) => c.name);
    expect(names).toContain("General");
    expect(names).toContain("Strategy");
    expect(names).toContain("Deep Work");
    expect(names).toContain("Ops");
    expect(names).toContain("Personal");
  });

  it("channels are tree-structured with children", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/channels`);
    const data = await res.json() as any;

    const strategy = data.channels.find((c: any) => c.name === "Strategy");
    expect(strategy).toBeDefined();
    expect(Array.isArray(strategy.children)).toBe(true);
    expect(strategy.children.length).toBeGreaterThan(0);

    const childNames = strategy.children.map((c: any) => c.name);
    expect(childNames).toContain("Architecture");
    expect(childNames).toContain("Roadmap");
  });

  it("GET /api/channels/:id returns channel with members", async () => {
    if (!isUp) return;
    const generalId = "a0000000-0000-0000-0000-000000000001";
    const res = await fetch(`${RELAY_URL}/api/channels/${generalId}`);
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(data.success).toBe(true);
    expect(data.channel.name).toBe("General");
    expect(Array.isArray(data.members)).toBe(true);
    expect(data.members.length).toBeGreaterThan(0);
  });

  it("POST /api/channels creates a new channel", async () => {
    if (!isUp) return;
    const name = `test-channel-${Date.now()}`;
    const res = await fetch(`${RELAY_URL}/api/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: "Test channel", context_mode: "conversation" }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(data.success).toBe(true);
    expect(data.channel.name).toBe(name);
    expect(data.channel.id).toBeDefined();

    // Clean up: archive it
    await fetch(`${RELAY_URL}/api/channels/${data.channel.id}/archive`, { method: "POST" });
  });

  it("PATCH /api/channels/:id updates channel", async () => {
    if (!isUp) return;
    // Create a channel to update
    const createRes = await fetch(`${RELAY_URL}/api/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `patch-test-${Date.now()}` }),
    });
    const { channel } = await createRes.json() as any;

    const patchRes = await fetch(`${RELAY_URL}/api/channels/${channel.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Updated description" }),
    });
    expect(patchRes.ok).toBe(true);
    const data = await patchRes.json() as any;
    expect(data.channel.description).toBe("Updated description");

    // Clean up
    await fetch(`${RELAY_URL}/api/channels/${channel.id}/archive`, { method: "POST" });
  });

  it("POST /api/channels/:id/archive archives channel", async () => {
    if (!isUp) return;
    const createRes = await fetch(`${RELAY_URL}/api/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `archive-test-${Date.now()}` }),
    });
    const { channel } = await createRes.json() as any;

    const archiveRes = await fetch(`${RELAY_URL}/api/channels/${channel.id}/archive`, { method: "POST" });
    expect(archiveRes.ok).toBe(true);
    const data = await archiveRes.json() as any;
    expect(data.channel.archived_at).not.toBeNull();

    // Should not appear in list anymore
    const listRes = await fetch(`${RELAY_URL}/api/channels`);
    const listData = await listRes.json() as any;
    const ids = listData.channels.flatMap((c: any) => [c.id, ...(c.children || []).map((ch: any) => ch.id)]);
    expect(ids).not.toContain(channel.id);
  });

  it("GET /api/channels/:id/members lists channel members", async () => {
    if (!isUp) return;
    const generalId = "a0000000-0000-0000-0000-000000000001";
    const res = await fetch(`${RELAY_URL}/api/channels/${generalId}/members`);
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(data.success).toBe(true);
    expect(data.members.length).toBeGreaterThan(0);

    // Should have agents
    const agentMembers = data.members.filter((m: any) => m.member_type === "agent");
    expect(agentMembers.length).toBeGreaterThan(0);
  });
});

describe("Agent Presence API", () => {
  let isUp = false;

  beforeAll(async () => {
    isUp = await relayUp();
  });

  it("GET /api/agents/presence returns all agents", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/agents/presence`);
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(data.success).toBe(true);
    expect(Array.isArray(data.presence)).toBe(true);
    expect(data.presence.length).toBe(7);

    const names = data.presence.map((p: any) => p.agent_name).sort();
    expect(names).toEqual(["content", "critic", "dev", "general", "ops", "research", "strategy"]);
  });

  it("all agents have valid status values", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/agents/presence`);
    const data = await res.json() as any;
    const validStatuses = ["online", "idle", "busy", "offline"];
    for (const p of data.presence) {
      expect(validStatuses).toContain(p.status);
    }
  });
});
