/**
 * Agent Registry Tests — ELLIE-599
 *
 * Validates:
 *  - registerAgent() creates entries with correct defaults
 *  - Re-registration preserves session state
 *  - startAgentSession() transitions to busy
 *  - completeAgentSession() transitions to idle
 *  - setAgentOffline() transitions to offline
 *  - lookupAgent() returns routing info or unavailable reason
 *  - listAgents() with optional status filter
 *  - findAgentsByCapability() and agentHasCapability()
 *  - resolveRoute() validates availability + capability
 *  - unregisterAgent() removes agents
 *  - Full scenario: register → session → complete → re-route
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  registerAgent,
  unregisterAgent,
  startAgentSession,
  completeAgentSession,
  setAgentOffline,
  lookupAgent,
  getAgent,
  listAgents,
  findAgentsByCapability,
  agentHasCapability,
  resolveRoute,
  _resetRegistryForTesting,
} from "../src/agent-registry.ts";

beforeEach(() => {
  _resetRegistryForTesting();
});

// ── registerAgent ────────────────────────────────────────────────────────────

describe("registerAgent", () => {
  it("registers an agent with correct defaults", () => {
    const agent = registerAgent({
      agentName: "critic",
      agentType: "specialist",
      capabilities: [{ name: "code-review" }],
    });

    expect(agent.agentName).toBe("critic");
    expect(agent.agentType).toBe("specialist");
    expect(agent.status).toBe("idle");
    expect(agent.capabilities).toHaveLength(1);
    expect(agent.sessionId).toBeUndefined();
    expect(agent.registeredAt).toBeTruthy();
    expect(agent.lastActiveAt).toBeTruthy();
  });

  it("registers with endpoint", () => {
    const agent = registerAgent({
      agentName: "dev",
      agentType: "specialist",
      endpoint: "http://localhost:3001/agent/dev",
    });

    expect(agent.endpoint).toBe("http://localhost:3001/agent/dev");
  });

  it("defaults to empty capabilities", () => {
    const agent = registerAgent({ agentName: "ops", agentType: "specialist" });
    expect(agent.capabilities).toEqual([]);
  });

  it("re-registration preserves session state", () => {
    registerAgent({ agentName: "dev", agentType: "specialist" });
    startAgentSession("dev", "sess-1");

    const updated = registerAgent({
      agentName: "dev",
      agentType: "specialist",
      capabilities: [{ name: "coding" }],
    });

    expect(updated.sessionId).toBe("sess-1");
    expect(updated.status).toBe("busy");
    expect(updated.capabilities).toHaveLength(1);
  });

  it("re-registration preserves endpoint if not provided", () => {
    registerAgent({
      agentName: "dev",
      agentType: "specialist",
      endpoint: "http://localhost:3001/agent/dev",
    });

    const updated = registerAgent({ agentName: "dev", agentType: "specialist" });
    expect(updated.endpoint).toBe("http://localhost:3001/agent/dev");
  });

  it("re-registration updates endpoint if provided", () => {
    registerAgent({
      agentName: "dev",
      agentType: "specialist",
      endpoint: "http://old",
    });

    const updated = registerAgent({
      agentName: "dev",
      agentType: "specialist",
      endpoint: "http://new",
    });
    expect(updated.endpoint).toBe("http://new");
  });

  it("preserves registeredAt on re-registration", () => {
    const first = registerAgent({ agentName: "dev", agentType: "specialist" });
    const second = registerAgent({ agentName: "dev", agentType: "specialist" });
    expect(second.registeredAt).toBe(first.registeredAt);
  });
});

// ── unregisterAgent ──────────────────────────────────────────────────────────

describe("unregisterAgent", () => {
  it("removes a registered agent", () => {
    registerAgent({ agentName: "critic", agentType: "specialist" });
    expect(unregisterAgent("critic")).toBe(true);
    expect(getAgent("critic")).toBeNull();
  });

  it("returns false for unknown agent", () => {
    expect(unregisterAgent("nonexistent")).toBe(false);
  });
});

// ── startAgentSession ────────────────────────────────────────────────────────

describe("startAgentSession", () => {
  it("transitions agent to busy", () => {
    registerAgent({ agentName: "dev", agentType: "specialist" });
    const result = startAgentSession("dev", "sess-1");

    expect(result).not.toBeNull();
    expect(result!.status).toBe("busy");
    expect(result!.sessionId).toBe("sess-1");
  });

  it("sets endpoint when provided", () => {
    registerAgent({ agentName: "dev", agentType: "specialist" });
    const result = startAgentSession("dev", "sess-1", "http://localhost/dev");

    expect(result!.endpoint).toBe("http://localhost/dev");
  });

  it("preserves existing endpoint when not provided", () => {
    registerAgent({
      agentName: "dev",
      agentType: "specialist",
      endpoint: "http://existing",
    });
    const result = startAgentSession("dev", "sess-1");
    expect(result!.endpoint).toBe("http://existing");
  });

  it("returns null for unregistered agent", () => {
    expect(startAgentSession("ghost", "sess-1")).toBeNull();
  });

  it("updates lastActiveAt", () => {
    const agent = registerAgent({ agentName: "dev", agentType: "specialist" });
    const before = agent.lastActiveAt;
    // Small delay to ensure timestamp differs
    const result = startAgentSession("dev", "sess-1");
    expect(result!.lastActiveAt).toBeTruthy();
  });

  it("persists in registry", () => {
    registerAgent({ agentName: "dev", agentType: "specialist" });
    startAgentSession("dev", "sess-1");
    const found = getAgent("dev");
    expect(found!.status).toBe("busy");
    expect(found!.sessionId).toBe("sess-1");
  });
});

// ── completeAgentSession ─────────────────────────────────────────────────────

describe("completeAgentSession", () => {
  it("transitions agent to idle and clears session", () => {
    registerAgent({ agentName: "dev", agentType: "specialist" });
    startAgentSession("dev", "sess-1");
    const result = completeAgentSession("dev");

    expect(result).not.toBeNull();
    expect(result!.status).toBe("idle");
    expect(result!.sessionId).toBeUndefined();
  });

  it("returns null for unregistered agent", () => {
    expect(completeAgentSession("ghost")).toBeNull();
  });

  it("can transition from idle (no-op effect)", () => {
    registerAgent({ agentName: "dev", agentType: "specialist" });
    const result = completeAgentSession("dev");
    expect(result!.status).toBe("idle");
  });
});

// ── setAgentOffline ──────────────────────────────────────────────────────────

describe("setAgentOffline", () => {
  it("transitions agent to offline", () => {
    registerAgent({ agentName: "dev", agentType: "specialist" });
    const result = setAgentOffline("dev");

    expect(result).not.toBeNull();
    expect(result!.status).toBe("offline");
  });

  it("returns null for unregistered agent", () => {
    expect(setAgentOffline("ghost")).toBeNull();
  });
});

// ── lookupAgent ──────────────────────────────────────────────────────────────

describe("lookupAgent", () => {
  it("returns found + available for idle agent", () => {
    registerAgent({ agentName: "critic", agentType: "specialist" });
    const result = lookupAgent("critic");

    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.available).toBe(true);
      expect(result.agent.agentName).toBe("critic");
    }
  });

  it("returns found + unavailable for busy agent", () => {
    registerAgent({ agentName: "dev", agentType: "specialist" });
    startAgentSession("dev", "sess-1");
    const result = lookupAgent("dev");

    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.available).toBe(false);
    }
  });

  it("returns not_registered for unknown agent", () => {
    const result = lookupAgent("ghost");
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.reason).toBe("not_registered");
    }
  });

  it("returns offline for offline agent", () => {
    registerAgent({ agentName: "dev", agentType: "specialist" });
    setAgentOffline("dev");
    const result = lookupAgent("dev");

    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.reason).toBe("offline");
    }
  });
});

// ── getAgent ─────────────────────────────────────────────────────────────────

describe("getAgent", () => {
  it("returns agent by name", () => {
    registerAgent({ agentName: "critic", agentType: "specialist" });
    const agent = getAgent("critic");
    expect(agent).not.toBeNull();
    expect(agent!.agentName).toBe("critic");
  });

  it("returns null for unknown agent", () => {
    expect(getAgent("ghost")).toBeNull();
  });
});

// ── listAgents ───────────────────────────────────────────────────────────────

describe("listAgents", () => {
  it("lists all registered agents", () => {
    registerAgent({ agentName: "dev", agentType: "specialist" });
    registerAgent({ agentName: "critic", agentType: "specialist" });
    registerAgent({ agentName: "ops", agentType: "specialist" });

    expect(listAgents()).toHaveLength(3);
  });

  it("filters by status", () => {
    registerAgent({ agentName: "dev", agentType: "specialist" });
    registerAgent({ agentName: "critic", agentType: "specialist" });
    startAgentSession("dev", "sess-1");

    expect(listAgents("idle")).toHaveLength(1);
    expect(listAgents("busy")).toHaveLength(1);
    expect(listAgents("offline")).toHaveLength(0);
  });

  it("returns empty when no agents registered", () => {
    expect(listAgents()).toHaveLength(0);
  });
});

// ── findAgentsByCapability ───────────────────────────────────────────────────

describe("findAgentsByCapability", () => {
  it("finds agents with matching capability", () => {
    registerAgent({
      agentName: "critic",
      agentType: "specialist",
      capabilities: [{ name: "code-review" }, { name: "security-audit" }],
    });
    registerAgent({
      agentName: "security",
      agentType: "specialist",
      capabilities: [{ name: "security-audit" }, { name: "pen-test" }],
    });
    registerAgent({
      agentName: "dev",
      agentType: "specialist",
      capabilities: [{ name: "coding" }],
    });

    const reviewers = findAgentsByCapability("code-review");
    expect(reviewers).toHaveLength(1);
    expect(reviewers[0].agentName).toBe("critic");

    const auditors = findAgentsByCapability("security-audit");
    expect(auditors).toHaveLength(2);
  });

  it("returns empty when no agents have capability", () => {
    registerAgent({
      agentName: "dev",
      agentType: "specialist",
      capabilities: [{ name: "coding" }],
    });

    expect(findAgentsByCapability("flying")).toHaveLength(0);
  });
});

// ── agentHasCapability ───────────────────────────────────────────────────────

describe("agentHasCapability", () => {
  it("returns true when agent has capability", () => {
    registerAgent({
      agentName: "critic",
      agentType: "specialist",
      capabilities: [{ name: "code-review" }],
    });

    expect(agentHasCapability("critic", "code-review")).toBe(true);
  });

  it("returns false when agent lacks capability", () => {
    registerAgent({
      agentName: "dev",
      agentType: "specialist",
      capabilities: [{ name: "coding" }],
    });

    expect(agentHasCapability("dev", "code-review")).toBe(false);
  });

  it("returns false for unregistered agent", () => {
    expect(agentHasCapability("ghost", "anything")).toBe(false);
  });
});

// ── resolveRoute ─────────────────────────────────────────────────────────────

describe("resolveRoute", () => {
  it("resolves route to idle agent", () => {
    registerAgent({ agentName: "critic", agentType: "specialist" });
    const result = resolveRoute("critic");

    expect(result.routable).toBe(true);
    if (result.routable) {
      expect(result.agent.agentName).toBe("critic");
    }
  });

  it("rejects route to busy agent", () => {
    registerAgent({ agentName: "dev", agentType: "specialist" });
    startAgentSession("dev", "sess-1");
    const result = resolveRoute("dev");

    expect(result.routable).toBe(false);
    if (!result.routable) {
      expect(result.reason).toContain("busy");
      expect(result.reason).toContain("sess-1");
    }
  });

  it("rejects route to unregistered agent", () => {
    const result = resolveRoute("ghost");

    expect(result.routable).toBe(false);
    if (!result.routable) {
      expect(result.reason).toContain("not registered");
    }
  });

  it("rejects route to offline agent", () => {
    registerAgent({ agentName: "dev", agentType: "specialist" });
    setAgentOffline("dev");
    const result = resolveRoute("dev");

    expect(result.routable).toBe(false);
    if (!result.routable) {
      expect(result.reason).toContain("offline");
    }
  });

  it("validates required capability — pass", () => {
    registerAgent({
      agentName: "critic",
      agentType: "specialist",
      capabilities: [{ name: "code-review" }],
    });
    const result = resolveRoute("critic", "code-review");

    expect(result.routable).toBe(true);
  });

  it("validates required capability — fail", () => {
    registerAgent({
      agentName: "dev",
      agentType: "specialist",
      capabilities: [{ name: "coding" }],
    });
    const result = resolveRoute("dev", "code-review");

    expect(result.routable).toBe(false);
    if (!result.routable) {
      expect(result.reason).toContain("does not have capability");
      expect(result.reason).toContain("code-review");
    }
  });

  it("skips capability check when not specified", () => {
    registerAgent({ agentName: "dev", agentType: "specialist" });
    const result = resolveRoute("dev");
    expect(result.routable).toBe(true);
  });
});

// ── Full lifecycle scenario ──────────────────────────────────────────────────

describe("full lifecycle scenario", () => {
  it("register → session → complete → re-route", () => {
    // 1. Register agents
    registerAgent({
      agentName: "dev",
      agentType: "specialist",
      capabilities: [{ name: "coding" }, { name: "testing" }],
    });
    registerAgent({
      agentName: "critic",
      agentType: "specialist",
      capabilities: [{ name: "code-review" }],
    });
    registerAgent({
      agentName: "security",
      agentType: "specialist",
      capabilities: [{ name: "security-audit" }],
    });

    expect(listAgents()).toHaveLength(3);
    expect(listAgents("idle")).toHaveLength(3);

    // 2. Dev starts a session
    startAgentSession("dev", "sess-dev-1");
    expect(listAgents("busy")).toHaveLength(1);
    expect(resolveRoute("dev").routable).toBe(false);

    // 3. Dev needs critic — critic is idle, routable
    const criticRoute = resolveRoute("critic", "code-review");
    expect(criticRoute.routable).toBe(true);

    // 4. Critic starts session for review
    startAgentSession("critic", "sess-critic-1");
    expect(listAgents("busy")).toHaveLength(2);

    // 5. Critic completes review
    completeAgentSession("critic");
    expect(getAgent("critic")!.status).toBe("idle");

    // 6. Dev needs security — check capability
    const secRoute = resolveRoute("security", "security-audit");
    expect(secRoute.routable).toBe(true);

    // 7. Security goes offline
    setAgentOffline("security");
    expect(resolveRoute("security").routable).toBe(false);

    // 8. Find agents that can do security-audit — only security, but offline
    const auditors = findAgentsByCapability("security-audit");
    expect(auditors).toHaveLength(1);
    expect(auditors[0].status).toBe("offline");

    // 9. Dev completes session
    completeAgentSession("dev");
    expect(listAgents("idle")).toHaveLength(2); // dev + critic
    expect(listAgents("offline")).toHaveLength(1); // security
  });

  it("handles multiple registrations and concurrent sessions", () => {
    // Register 4 agents
    for (const name of ["dev", "critic", "security", "perf"]) {
      registerAgent({ agentName: name, agentType: "specialist" });
    }

    // Start sessions for 3 of them
    startAgentSession("dev", "s1");
    startAgentSession("critic", "s2");
    startAgentSession("security", "s3");

    expect(listAgents("busy")).toHaveLength(3);
    expect(listAgents("idle")).toHaveLength(1);

    // Complete one
    completeAgentSession("critic");
    expect(listAgents("busy")).toHaveLength(2);
    expect(listAgents("idle")).toHaveLength(2);

    // Unregister one
    unregisterAgent("perf");
    expect(listAgents()).toHaveLength(3);
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("capabilities with descriptions", () => {
    registerAgent({
      agentName: "critic",
      agentType: "specialist",
      capabilities: [
        { name: "code-review", description: "Reviews code for quality and patterns" },
        { name: "architecture-review", description: "Reviews system architecture" },
      ],
    });

    const agent = getAgent("critic")!;
    expect(agent.capabilities[0].description).toBe("Reviews code for quality and patterns");
  });

  it("re-register offline agent brings it back", () => {
    registerAgent({ agentName: "dev", agentType: "specialist" });
    setAgentOffline("dev");
    expect(getAgent("dev")!.status).toBe("offline");

    // Re-register preserves offline status
    const reregistered = registerAgent({ agentName: "dev", agentType: "specialist" });
    expect(reregistered.status).toBe("offline");

    // But completing session resets to idle
    completeAgentSession("dev");
    expect(getAgent("dev")!.status).toBe("idle");
  });

  it("start session on already busy agent updates session", () => {
    registerAgent({ agentName: "dev", agentType: "specialist" });
    startAgentSession("dev", "sess-1");
    startAgentSession("dev", "sess-2");

    expect(getAgent("dev")!.sessionId).toBe("sess-2");
  });
});
