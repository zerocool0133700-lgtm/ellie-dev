/**
 * Formation Atomic Checkout Tests — ELLIE-721
 *
 * Tests for compare-and-swap checkout semantics on formation_sessions:
 * - Migration SQL structure
 * - Type shapes (compile-time + runtime)
 * - Atomic checkout (CAS) logic
 * - Release on completion/failure
 * - Force-release (stale recovery)
 * - Stale checkout detection
 * - Concurrent checkout scenarios
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import type {
  FormationSession,
  FormationCheckoutStatus,
} from "../src/types/formation.ts";
import {
  VALID_CHECKOUT_STATUSES,
} from "../src/types/formation.ts";

// ── Mock SQL Layer ──────────────────────────────────────────

type SqlRow = Record<string, unknown>;
type SqlResult = SqlRow[];

let sqlMockResults: SqlResult[] = [];
let sqlCallIndex = 0;
let sqlCalls: { strings: TemplateStringsArray; values: unknown[] }[] = [];

function resetSqlMock() {
  sqlMockResults = [];
  sqlCallIndex = 0;
  sqlCalls = [];
}

function pushSqlResult(rows: SqlResult) {
  sqlMockResults.push(rows);
}

const mockSql = Object.assign(
  function sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlResult> {
    sqlCalls.push({ strings, values });
    const result = sqlMockResults[sqlCallIndex] ?? [];
    sqlCallIndex++;
    return Promise.resolve(result);
  },
  { json: (v: unknown) => v, array: (v: unknown) => v },
);

// Mock the ellie-forest module before importing the checkout module
mock.module("../../ellie-forest/src/index", () => ({
  sql: mockSql,
}));

// Import after mocking
const {
  checkoutSession,
  startSession,
  releaseSession,
  forceReleaseSession,
  findStaleCheckouts,
  releaseStaleCheckouts,
  DEFAULT_STALE_TIMEOUT_MS,
} = await import("../src/formation-checkout.ts");

// ── Setup ───────────────────────────────────────────────────

beforeEach(() => {
  resetSqlMock();
});

// ── Migration SQL ───────────────────────────────────────────

describe("migration SQL", () => {
  const migrationPath = join(
    import.meta.dir,
    "../migrations/supabase/20260315_formation_checkout.sql",
  );
  let migrationSql: string;

  test("migration file exists", () => {
    migrationSql = readFileSync(migrationPath, "utf-8");
    expect(migrationSql.length).toBeGreaterThan(0);
  });

  test("adds checked_out_by column with FK to agents", () => {
    migrationSql = readFileSync(migrationPath, "utf-8");
    expect(migrationSql).toContain("checked_out_by UUID");
    expect(migrationSql).toContain("REFERENCES agents(id)");
  });

  test("adds checked_out_at column", () => {
    migrationSql = readFileSync(migrationPath, "utf-8");
    expect(migrationSql).toContain("checked_out_at TIMESTAMPTZ");
  });

  test("adds status column with CHECK constraint", () => {
    migrationSql = readFileSync(migrationPath, "utf-8");
    expect(migrationSql).toContain("status TEXT");
    expect(migrationSql).toContain("'pending'");
    expect(migrationSql).toContain("'checked_out'");
    expect(migrationSql).toContain("'in_progress'");
    expect(migrationSql).toContain("'completed'");
    expect(migrationSql).toContain("'failed'");
  });

  test("creates index on checked_out_by", () => {
    migrationSql = readFileSync(migrationPath, "utf-8");
    expect(migrationSql).toContain("idx_formation_sessions_checked_out_by");
  });

  test("creates index on status", () => {
    migrationSql = readFileSync(migrationPath, "utf-8");
    expect(migrationSql).toContain("idx_formation_sessions_status");
  });

  test("creates stale checkout detection index", () => {
    migrationSql = readFileSync(migrationPath, "utf-8");
    expect(migrationSql).toContain("idx_formation_sessions_stale_checkout");
    expect(migrationSql).toContain("checked_out_at");
  });

  test("uses IF NOT EXISTS for idempotent application", () => {
    migrationSql = readFileSync(migrationPath, "utf-8");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS checked_out_by");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS checked_out_at");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS status");
    expect(migrationSql).toContain("CREATE INDEX IF NOT EXISTS");
  });
});

// ── Type Shapes ─────────────────────────────────────────────

describe("type shapes", () => {
  test("FormationSession includes checkout fields", () => {
    const session: FormationSession = {
      id: "test-id",
      created_at: new Date(),
      updated_at: new Date(),
      completed_at: null,
      formation_name: "test",
      state: "active",
      turn_count: 0,
      initiator_agent: "dev",
      channel: "internal",
      work_item_id: null,
      protocol: { pattern: "free-form", maxTurns: 0, requiresApproval: false },
      participating_agents: ["dev"],
      metadata: {},
      checked_out_by: null,
      checked_out_at: null,
      status: "pending",
    };
    expect(session.checked_out_by).toBeNull();
    expect(session.checked_out_at).toBeNull();
    expect(session.status).toBe("pending");
  });

  test("FormationSession with active checkout", () => {
    const session: FormationSession = {
      id: "test-id",
      created_at: new Date(),
      updated_at: new Date(),
      completed_at: null,
      formation_name: "test",
      state: "active",
      turn_count: 0,
      initiator_agent: "dev",
      channel: "internal",
      work_item_id: null,
      protocol: { pattern: "free-form", maxTurns: 0, requiresApproval: false },
      participating_agents: ["dev"],
      metadata: {},
      checked_out_by: "550e8400-e29b-41d4-a716-446655440000",
      checked_out_at: new Date(),
      status: "checked_out",
    };
    expect(session.checked_out_by).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(session.status).toBe("checked_out");
  });

  test("VALID_CHECKOUT_STATUSES has all expected values", () => {
    expect(VALID_CHECKOUT_STATUSES).toContain("pending");
    expect(VALID_CHECKOUT_STATUSES).toContain("checked_out");
    expect(VALID_CHECKOUT_STATUSES).toContain("in_progress");
    expect(VALID_CHECKOUT_STATUSES).toContain("completed");
    expect(VALID_CHECKOUT_STATUSES).toContain("failed");
    expect(VALID_CHECKOUT_STATUSES).toHaveLength(5);
  });

  test("all checkout statuses are assignable to FormationCheckoutStatus", () => {
    const statuses: FormationCheckoutStatus[] = [
      "pending",
      "checked_out",
      "in_progress",
      "completed",
      "failed",
    ];
    for (const s of statuses) {
      expect(VALID_CHECKOUT_STATUSES).toContain(s);
    }
  });
});

// ── Constants ───────────────────────────────────────────────

describe("constants", () => {
  test("DEFAULT_STALE_TIMEOUT_MS is 30 minutes", () => {
    expect(DEFAULT_STALE_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });
});

// ── checkoutSession ─────────────────────────────────────────

describe("checkoutSession", () => {
  const sessionId = "550e8400-e29b-41d4-a716-446655440000";
  const agentId = "660e8400-e29b-41d4-a716-446655440001";
  const now = new Date();

  test("successful checkout returns success with checkout details", async () => {
    pushSqlResult([
      { id: sessionId, checked_out_by: agentId, checked_out_at: now, status: "checked_out" },
    ]);

    const result = await checkoutSession(sessionId, agentId);
    expect(result.success).toBe(true);
    expect(result.session_id).toBe(sessionId);
    expect(result.checked_out_by).toBe(agentId);
    expect(result.status).toBe("checked_out");
  });

  test("CAS UPDATE includes WHERE checked_out_by IS NULL AND status = pending", async () => {
    pushSqlResult([
      { id: sessionId, checked_out_by: agentId, checked_out_at: now, status: "checked_out" },
    ]);

    await checkoutSession(sessionId, agentId);

    // First SQL call should be the UPDATE with CAS conditions
    const firstCall = sqlCalls[0];
    const sqlText = firstCall.strings.join("?");
    expect(sqlText).toContain("UPDATE formation_sessions");
    expect(sqlText).toContain("checked_out_by IS NULL");
    expect(sqlText).toContain("status = 'pending'");
  });

  test("failed checkout (already checked out) returns success=false", async () => {
    // UPDATE returns empty (CAS failed)
    pushSqlResult([]);
    // SELECT returns current state
    pushSqlResult([
      { id: sessionId, checked_out_by: "other-agent", checked_out_at: now, status: "checked_out" },
    ]);

    const result = await checkoutSession(sessionId, agentId);
    expect(result.success).toBe(false);
    expect(result.checked_out_by).toBe("other-agent");
    expect(result.status).toBe("checked_out");
  });

  test("checkout of nonexistent session throws", async () => {
    // UPDATE returns empty
    pushSqlResult([]);
    // SELECT returns empty
    pushSqlResult([]);

    await expect(checkoutSession(sessionId, agentId)).rejects.toThrow(
      `Formation session ${sessionId} not found`,
    );
  });

  test("checkout of already completed session returns success=false", async () => {
    pushSqlResult([]);
    pushSqlResult([
      { id: sessionId, checked_out_by: null, checked_out_at: null, status: "completed" },
    ]);

    const result = await checkoutSession(sessionId, agentId);
    expect(result.success).toBe(false);
    expect(result.status).toBe("completed");
    expect(result.checked_out_by).toBeNull();
  });
});

// ── Concurrent Checkout Scenarios ───────────────────────────

describe("concurrent checkout scenarios", () => {
  const sessionId = "550e8400-e29b-41d4-a716-446655440000";
  const agent1 = "660e8400-e29b-41d4-a716-446655440001";
  const agent2 = "770e8400-e29b-41d4-a716-446655440002";
  const now = new Date();

  test("first checkout wins, second fails gracefully", async () => {
    // Agent 1 checkout: UPDATE succeeds
    pushSqlResult([
      { id: sessionId, checked_out_by: agent1, checked_out_at: now, status: "checked_out" },
    ]);

    const result1 = await checkoutSession(sessionId, agent1);
    expect(result1.success).toBe(true);
    expect(result1.checked_out_by).toBe(agent1);

    resetSqlMock();

    // Agent 2 checkout: UPDATE fails (CAS), SELECT shows agent1 holds it
    pushSqlResult([]);
    pushSqlResult([
      { id: sessionId, checked_out_by: agent1, checked_out_at: now, status: "checked_out" },
    ]);

    const result2 = await checkoutSession(sessionId, agent2);
    expect(result2.success).toBe(false);
    expect(result2.checked_out_by).toBe(agent1);
  });

  test("simultaneous checkout attempts — only one can succeed", async () => {
    // Simulate two agents racing. In a real DB, only one UPDATE
    // would match. Here we verify the function correctly reports
    // success/failure based on the DB response.

    // Agent 1 wins
    resetSqlMock();
    pushSqlResult([
      { id: sessionId, checked_out_by: agent1, checked_out_at: now, status: "checked_out" },
    ]);
    const winner = await checkoutSession(sessionId, agent1);

    // Agent 2 loses
    resetSqlMock();
    pushSqlResult([]);
    pushSqlResult([
      { id: sessionId, checked_out_by: agent1, checked_out_at: now, status: "checked_out" },
    ]);
    const loser = await checkoutSession(sessionId, agent2);

    expect(winner.success).toBe(true);
    expect(loser.success).toBe(false);
    expect(winner.checked_out_by).toBe(agent1);
    expect(loser.checked_out_by).toBe(agent1);
  });

  test("checkout after release succeeds for a different agent", async () => {
    // Agent 1 checks out
    pushSqlResult([
      { id: sessionId, checked_out_by: agent1, checked_out_at: now, status: "checked_out" },
    ]);
    const r1 = await checkoutSession(sessionId, agent1);
    expect(r1.success).toBe(true);

    resetSqlMock();

    // Agent 1 releases (completes)
    pushSqlResult([{ id: sessionId, status: "completed" }]);
    const rel = await releaseSession(sessionId, agent1, "completed");
    expect(rel.success).toBe(true);

    resetSqlMock();

    // Session gets reset to pending (e.g., retry scenario with force-release)
    // Agent 2 can now check out
    pushSqlResult([
      { id: sessionId, checked_out_by: agent2, checked_out_at: now, status: "checked_out" },
    ]);
    const r2 = await checkoutSession(sessionId, agent2);
    expect(r2.success).toBe(true);
    expect(r2.checked_out_by).toBe(agent2);
  });
});

// ── startSession ────────────────────────────────────────────

describe("startSession", () => {
  const sessionId = "550e8400-e29b-41d4-a716-446655440000";
  const agentId = "660e8400-e29b-41d4-a716-446655440001";
  const now = new Date();

  test("transitions checked_out to in_progress", async () => {
    pushSqlResult([
      { id: sessionId, checked_out_by: agentId, checked_out_at: now, status: "in_progress" },
    ]);

    const result = await startSession(sessionId, agentId);
    expect(result.success).toBe(true);
    expect(result.status).toBe("in_progress");
  });

  test("requires matching agent to start", async () => {
    // UPDATE returns empty — wrong agent or wrong status
    pushSqlResult([]);

    await expect(startSession(sessionId, agentId)).rejects.toThrow(
      "Cannot start session",
    );
  });

  test("UPDATE checks for correct agent and checked_out status", async () => {
    pushSqlResult([
      { id: sessionId, checked_out_by: agentId, checked_out_at: now, status: "in_progress" },
    ]);

    await startSession(sessionId, agentId);

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("checked_out_by =");
    expect(sqlText).toContain("status = 'checked_out'");
  });
});

// ── releaseSession ──────────────────────────────────────────

describe("releaseSession", () => {
  const sessionId = "550e8400-e29b-41d4-a716-446655440000";
  const agentId = "660e8400-e29b-41d4-a716-446655440001";

  test("release with completed status", async () => {
    pushSqlResult([{ id: sessionId, status: "completed" }]);

    const result = await releaseSession(sessionId, agentId, "completed");
    expect(result.success).toBe(true);
    expect(result.status).toBe("completed");
  });

  test("release with failed status", async () => {
    pushSqlResult([{ id: sessionId, status: "failed" }]);

    const result = await releaseSession(sessionId, agentId, "failed");
    expect(result.success).toBe(true);
    expect(result.status).toBe("failed");
  });

  test("release clears checkout fields in SQL", async () => {
    pushSqlResult([{ id: sessionId, status: "completed" }]);

    await releaseSession(sessionId, agentId, "completed");

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("checked_out_by = NULL");
    expect(sqlText).toContain("checked_out_at = NULL");
  });

  test("release only works for the holding agent", async () => {
    pushSqlResult([]);

    await expect(releaseSession(sessionId, agentId, "completed")).rejects.toThrow(
      "Cannot release session",
    );
  });

  test("release only works for checked_out or in_progress status", async () => {
    pushSqlResult([{ id: sessionId, status: "completed" }]);

    await releaseSession(sessionId, agentId, "completed");

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("IN ('checked_out', 'in_progress')");
  });
});

// ── forceReleaseSession ─────────────────────────────────────

describe("forceReleaseSession", () => {
  const sessionId = "550e8400-e29b-41d4-a716-446655440000";

  test("force release resets to pending", async () => {
    pushSqlResult([{ id: sessionId, status: "pending" }]);

    const result = await forceReleaseSession(sessionId);
    expect(result.success).toBe(true);
    expect(result.status).toBe("pending");
  });

  test("force release works regardless of who holds checkout", async () => {
    pushSqlResult([{ id: sessionId, status: "pending" }]);

    await forceReleaseSession(sessionId);

    // Only the session ID should be passed as a parameter — no agent ID
    const call = sqlCalls[0];
    expect(call.values).toHaveLength(1);
    expect(call.values[0]).toBe(sessionId);

    const sqlText = call.strings.join("?");
    expect(sqlText).toContain("checked_out_by IS NOT NULL");
  });

  test("force release of non-checked-out session throws", async () => {
    pushSqlResult([]);

    await expect(forceReleaseSession(sessionId)).rejects.toThrow(
      "Cannot force-release session",
    );
  });
});

// ── findStaleCheckouts ──────────────────────────────────────

describe("findStaleCheckouts", () => {
  test("returns stale sessions", async () => {
    const staleTime = new Date(Date.now() - 60 * 60 * 1000);
    pushSqlResult([
      {
        session_id: "sess-1",
        checked_out_by: "agent-1",
        checked_out_at: staleTime,
        status: "checked_out",
        formation_name: "code-review",
      },
    ]);

    const stale = await findStaleCheckouts();
    expect(stale).toHaveLength(1);
    expect(stale[0].session_id).toBe("sess-1");
    expect(stale[0].formation_name).toBe("code-review");
  });

  test("uses default 30-minute timeout", async () => {
    pushSqlResult([]);

    await findStaleCheckouts();

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("INTERVAL '1 second'");
    // The timeout value passed should be 1800 (30 min in seconds)
    expect(sqlCalls[0].values).toContain(1800);
  });

  test("accepts custom timeout", async () => {
    pushSqlResult([]);

    await findStaleCheckouts(10 * 60 * 1000); // 10 minutes

    expect(sqlCalls[0].values).toContain(600);
  });

  test("filters for checked_out and in_progress statuses only", async () => {
    pushSqlResult([]);

    await findStaleCheckouts();

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("IN ('checked_out', 'in_progress')");
  });

  test("returns empty array when no stale checkouts", async () => {
    pushSqlResult([]);

    const stale = await findStaleCheckouts();
    expect(stale).toHaveLength(0);
  });
});

// ── releaseStaleCheckouts ───────────────────────────────────

describe("releaseStaleCheckouts", () => {
  test("releases stale sessions and returns them", async () => {
    const staleTime = new Date(Date.now() - 60 * 60 * 1000);
    pushSqlResult([
      {
        session_id: "sess-1",
        checked_out_by: "agent-1",
        checked_out_at: staleTime,
        status: "pending",
        formation_name: "code-review",
      },
      {
        session_id: "sess-2",
        checked_out_by: "agent-2",
        checked_out_at: staleTime,
        status: "pending",
        formation_name: "think-tank",
      },
    ]);

    const released = await releaseStaleCheckouts();
    expect(released).toHaveLength(2);
    expect(released[0].session_id).toBe("sess-1");
    expect(released[1].session_id).toBe("sess-2");
  });

  test("uses UPDATE to atomically release stale checkouts", async () => {
    pushSqlResult([]);

    await releaseStaleCheckouts();

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("UPDATE formation_sessions");
    expect(sqlText).toContain("checked_out_by = NULL");
    expect(sqlText).toContain("checked_out_at = NULL");
    expect(sqlText).toContain("status = 'pending'");
  });

  test("accepts custom timeout", async () => {
    pushSqlResult([]);

    await releaseStaleCheckouts(5 * 60 * 1000); // 5 minutes

    expect(sqlCalls[0].values).toContain(300);
  });

  test("returns empty array when nothing is stale", async () => {
    pushSqlResult([]);

    const released = await releaseStaleCheckouts();
    expect(released).toHaveLength(0);
  });
});

// ── E2E: Full Checkout Lifecycle ────────────────────────────

describe("E2E: checkout lifecycle", () => {
  const sessionId = "550e8400-e29b-41d4-a716-446655440000";
  const agentId = "660e8400-e29b-41d4-a716-446655440001";
  const now = new Date();

  test("pending → checkout → in_progress → completed", async () => {
    // Step 1: Checkout
    pushSqlResult([
      { id: sessionId, checked_out_by: agentId, checked_out_at: now, status: "checked_out" },
    ]);
    const checkout = await checkoutSession(sessionId, agentId);
    expect(checkout.success).toBe(true);
    expect(checkout.status).toBe("checked_out");

    resetSqlMock();

    // Step 2: Start
    pushSqlResult([
      { id: sessionId, checked_out_by: agentId, checked_out_at: now, status: "in_progress" },
    ]);
    const started = await startSession(sessionId, agentId);
    expect(started.success).toBe(true);
    expect(started.status).toBe("in_progress");

    resetSqlMock();

    // Step 3: Release (completed)
    pushSqlResult([{ id: sessionId, status: "completed" }]);
    const released = await releaseSession(sessionId, agentId, "completed");
    expect(released.success).toBe(true);
    expect(released.status).toBe("completed");
  });

  test("pending → checkout → in_progress → failed", async () => {
    pushSqlResult([
      { id: sessionId, checked_out_by: agentId, checked_out_at: now, status: "checked_out" },
    ]);
    const checkout = await checkoutSession(sessionId, agentId);
    expect(checkout.success).toBe(true);

    resetSqlMock();

    pushSqlResult([
      { id: sessionId, checked_out_by: agentId, checked_out_at: now, status: "in_progress" },
    ]);
    await startSession(sessionId, agentId);

    resetSqlMock();

    pushSqlResult([{ id: sessionId, status: "failed" }]);
    const released = await releaseSession(sessionId, agentId, "failed");
    expect(released.success).toBe(true);
    expect(released.status).toBe("failed");
  });

  test("stale checkout → force release → re-checkout by new agent", async () => {
    const agent2 = "770e8400-e29b-41d4-a716-446655440002";

    // Session is stale (someone checked out and never came back)
    pushSqlResult([{ id: sessionId, status: "pending" }]);
    const forceRel = await forceReleaseSession(sessionId);
    expect(forceRel.success).toBe(true);
    expect(forceRel.status).toBe("pending");

    resetSqlMock();

    // New agent can now check out
    pushSqlResult([
      { id: sessionId, checked_out_by: agent2, checked_out_at: now, status: "checked_out" },
    ]);
    const reCheckout = await checkoutSession(sessionId, agent2);
    expect(reCheckout.success).toBe(true);
    expect(reCheckout.checked_out_by).toBe(agent2);
  });
});

// ── SQL Safety ──────────────────────────────────────────────

describe("SQL safety", () => {
  const sessionId = "550e8400-e29b-41d4-a716-446655440000";
  const agentId = "660e8400-e29b-41d4-a716-446655440001";

  test("checkout uses parameterized queries (no string interpolation)", async () => {
    pushSqlResult([
      { id: sessionId, checked_out_by: agentId, checked_out_at: new Date(), status: "checked_out" },
    ]);

    await checkoutSession(sessionId, agentId);

    // postgres.js tagged templates use parameterized queries by design.
    // Verify the session ID and agent ID are passed as values, not embedded in SQL strings.
    const call = sqlCalls[0];
    expect(call.values).toContain(agentId);
    expect(call.values).toContain(sessionId);
    // The SQL template strings should NOT contain the actual UUIDs
    const rawSql = call.strings.join("");
    expect(rawSql).not.toContain(sessionId);
    expect(rawSql).not.toContain(agentId);
  });

  test("release uses parameterized queries", async () => {
    pushSqlResult([{ id: sessionId, status: "completed" }]);

    await releaseSession(sessionId, agentId, "completed");

    const call = sqlCalls[0];
    expect(call.values).toContain(sessionId);
    expect(call.values).toContain(agentId);
  });
});
