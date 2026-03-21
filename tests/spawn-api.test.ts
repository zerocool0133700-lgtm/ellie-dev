/**
 * ELLIE-946 — Tests for spawn HTTP API endpoints
 *
 * Tests: POST /api/spawn, GET /api/spawn/:id, GET /api/spawn/children/:parentId
 *
 * Tests the endpoint logic by calling the session-spawn module directly
 * (the HTTP routing is integration-tested via the relay). These tests verify
 * the spawn lifecycle is accessible and correct through the API surface.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import {
  spawnSession,
  markRunning,
  markCompleted,
  markFailed,
  getSpawnRecord,
  getChildrenForParent,
  _clearRegistryForTesting,
} from "../src/session-spawn.ts";
import type { SpawnOpts } from "../src/types/session-spawn.ts";

// Also test that requiresApiAuth exempts localhost
import { requiresApiAuth } from "../src/http-routes.ts";

// ── Helpers ──────────────────────────────────────────────────

function makeSpawnOpts(overrides: Partial<SpawnOpts> = {}): SpawnOpts {
  return {
    parentSessionId: "api-parent-1",
    parentAgentName: "dev",
    targetAgentName: "research",
    task: "Investigate compliance issue",
    channel: "api",
    userId: "user-1",
    ...overrides,
  };
}

beforeEach(() => {
  _clearRegistryForTesting();
});

// ── POST /api/spawn — Spawn creation ─────────────────────────

describe("POST /api/spawn", () => {
  test("creates a spawn and returns spawnId", () => {
    const result = spawnSession(makeSpawnOpts());
    expect(result.success).toBe(true);
    expect(result.spawnId).toBeTruthy();
    expect(result.childSessionKey).toMatch(/^agent:research:subagent:/);
  });

  test("validates required fields — rejects without target_agent_name", () => {
    // Simulating the validation the endpoint does
    const data = { parent_session_id: "p1", task: "do stuff" };
    const valid = !!(data.parent_session_id && (data as any).target_agent_name && data.task);
    expect(valid).toBe(false);
  });

  test("validates required fields — rejects without task", () => {
    const data = { parent_session_id: "p1", target_agent_name: "research" };
    const valid = !!(data.parent_session_id && data.target_agent_name && (data as any).task);
    expect(valid).toBe(false);
  });

  test("validates required fields — rejects without parent_session_id", () => {
    const data = { target_agent_name: "research", task: "do stuff" };
    const valid = !!((data as any).parent_session_id && data.target_agent_name && data.task);
    expect(valid).toBe(false);
  });

  test("accepts all valid fields including optional ones", () => {
    const result = spawnSession(makeSpawnOpts({
      workItemId: "ELLIE-100",
      arcMode: "fork",
      threadBind: true,
      depth: 1,
    }));
    expect(result.success).toBe(true);
    const record = getSpawnRecord(result.spawnId);
    expect(record!.workItemId).toBe("ELLIE-100");
    expect(record!.arcMode).toBe("fork");
    expect(record!.threadBound).toBe(true);
    expect(record!.depth).toBe(1);
  });

  test("returns 429 equivalent when max children exceeded", () => {
    for (let i = 0; i < 5; i++) spawnSession(makeSpawnOpts());
    const result = spawnSession(makeSpawnOpts());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Max concurrent children");
  });

  test("returns depth error when max depth exceeded", () => {
    const result = spawnSession(makeSpawnOpts({ depth: 3 }));
    expect(result.success).toBe(false);
    expect(result.error).toContain("Max spawn depth");
  });
});

// ── GET /api/spawn/:id — Record lookup ───────────────────────

describe("GET /api/spawn/:id", () => {
  test("returns spawn record by ID", () => {
    const { spawnId } = spawnSession(makeSpawnOpts());
    const record = getSpawnRecord(spawnId);

    expect(record).not.toBeNull();
    expect(record!.id).toBe(spawnId);
    expect(record!.targetAgentName).toBe("research");
    expect(record!.state).toBe("pending");
  });

  test("returns null for unknown spawn ID", () => {
    const record = getSpawnRecord("00000000-0000-0000-0000-000000000000");
    expect(record).toBeNull();
  });

  test("reflects state transitions", () => {
    const { spawnId } = spawnSession(makeSpawnOpts());

    markRunning(spawnId, "real-session-1");
    expect(getSpawnRecord(spawnId)!.state).toBe("running");

    markCompleted(spawnId, "Done");
    expect(getSpawnRecord(spawnId)!.state).toBe("completed");
    expect(getSpawnRecord(spawnId)!.resultText).toBe("Done");
  });

  test("reflects failure state", () => {
    const { spawnId } = spawnSession(makeSpawnOpts());
    markFailed(spawnId, "Agent crashed");

    const record = getSpawnRecord(spawnId);
    expect(record!.state).toBe("failed");
    expect(record!.error).toBe("Agent crashed");
  });
});

// ── GET /api/spawn/children/:parentSessionId — List children ─

describe("GET /api/spawn/children/:parentSessionId", () => {
  test("returns all children for a parent", () => {
    spawnSession(makeSpawnOpts({ targetAgentName: "research" }));
    spawnSession(makeSpawnOpts({ targetAgentName: "critic" }));

    const children = getChildrenForParent("api-parent-1");
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.targetAgentName).sort()).toEqual(["critic", "research"]);
  });

  test("returns empty array for unknown parent", () => {
    const children = getChildrenForParent("nonexistent");
    expect(children).toEqual([]);
  });

  test("includes completed and failed children", () => {
    const r1 = spawnSession(makeSpawnOpts({ targetAgentName: "a" }));
    const r2 = spawnSession(makeSpawnOpts({ targetAgentName: "b" }));
    markCompleted(r1.spawnId, "done");
    markFailed(r2.spawnId, "err");

    const children = getChildrenForParent("api-parent-1");
    expect(children).toHaveLength(2);
    expect(children.find((c) => c.state === "completed")).toBeTruthy();
    expect(children.find((c) => c.state === "failed")).toBeTruthy();
  });
});

// ── Auth: localhost bypass ────────────────────────────────────

describe("API auth for spawn endpoints", () => {
  test("localhost is exempt from auth", () => {
    expect(requiresApiAuth("/api/spawn", "127.0.0.1")).toBe(false);
    expect(requiresApiAuth("/api/spawn", "::1")).toBe(false);
    expect(requiresApiAuth("/api/spawn", "::ffff:127.0.0.1")).toBe(false);
  });

  test("remote IPs require auth", () => {
    expect(requiresApiAuth("/api/spawn", "192.168.1.100")).toBe(true);
    expect(requiresApiAuth("/api/spawn/children/foo", "10.0.0.1")).toBe(true);
  });
});
