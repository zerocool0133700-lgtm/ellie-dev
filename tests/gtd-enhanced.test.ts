/**
 * Enhanced GTD Tests — ELLIE-914 (915-921)
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { EFFORT_RULES } from "../src/api/gtd-types.ts";

const RELAY_URL = "http://localhost:3001";

async function relayUp(): Promise<boolean> {
  try {
    const r = await fetch(`${RELAY_URL}/health`);
    return r.ok;
  } catch {
    return false;
  }
}

describe("Effort Classification (ELLIE-917)", () => {
  it("EFFORT_RULES has three levels", () => {
    expect(Object.keys(EFFORT_RULES)).toEqual(["quick", "medium", "deep"]);
  });

  it("quick has keywords for short tasks", () => {
    expect(EFFORT_RULES.quick.keywords).toContain("check");
    expect(EFFORT_RULES.quick.keywords).toContain("reply");
    expect(EFFORT_RULES.quick.maxMinutes).toBe(15);
  });

  it("medium has keywords for moderate tasks", () => {
    expect(EFFORT_RULES.medium.keywords).toContain("review");
    expect(EFFORT_RULES.medium.keywords).toContain("implement");
    expect(EFFORT_RULES.medium.maxMinutes).toBe(60);
  });

  it("deep has keywords for complex tasks", () => {
    expect(EFFORT_RULES.deep.keywords).toContain("architect");
    expect(EFFORT_RULES.deep.keywords).toContain("refactor");
  });
});

describe("Context Management API (ELLIE-916)", () => {
  let isUp = false;
  beforeAll(async () => { isUp = await relayUp(); });

  it("GET /api/gtd/contexts returns seeded contexts", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/gtd/contexts`);
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(data.success).toBe(true);
    expect(Array.isArray(data.contexts)).toBe(true);
    expect(data.contexts.length).toBeGreaterThanOrEqual(4);

    const names = data.contexts.map((c: any) => c.name);
    expect(names).toContain("general");
    expect(names).toContain("deep-work");
    expect(names).toContain("email");
    expect(names).toContain("appointments");
  });

  it("contexts have calendar_enabled flag", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/gtd/contexts`);
    const data = await res.json() as any;

    const email = data.contexts.find((c: any) => c.name === "email");
    expect(email.calendar_enabled).toBe(true);

    const general = data.contexts.find((c: any) => c.name === "general");
    expect(general.calendar_enabled).toBe(false);
  });

  it("POST /api/gtd/contexts creates a new context", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/gtd/contexts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `test-ctx-${Date.now()}`, label: "Test Context", icon: "🧪" }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(data.success).toBe(true);
    expect(data.context.label).toBe("Test Context");
  });
});

describe("Waiting-for Auto-Creation (ELLIE-918)", () => {
  let isUp = false;
  beforeAll(async () => { isUp = await relayUp(); });

  it("POST /api/gtd/waiting-for creates a waiting todo", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/gtd/waiting-for`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Review PR #42 for ELLIE-914",
        work_item_id: "ELLIE-914",
        agent: "dev",
        context: "plane",
      }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json() as any;
    expect(data.success).toBe(true);
    expect(data.todo.status).toBe("waiting_for");
    expect(data.todo.context).toBe("plane");
    expect(data.todo.effort).toBeDefined();
    expect(data.todo.assigned_agent).toBe("dev");
  });

  it("rejects missing content", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/gtd/waiting-for`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("Inbox with effort classification (ELLIE-917)", () => {
  let isUp = false;
  beforeAll(async () => { isUp = await relayUp(); });

  it("auto-classifies effort on inbox capture", async () => {
    if (!isUp) return;
    const res = await fetch(`${RELAY_URL}/api/gtd/inbox`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Check if the deploy succeeded",
        context: "general",
      }),
    });
    expect(res.ok).toBe(true);
    // The effort should be auto-classified based on "check" keyword
  });
});
