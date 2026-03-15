/**
 * Agent Delegation Flows Tests — ELLIE-727
 *
 * Tests for delegation and escalation between agents:
 * - Migration SQL structure
 * - Type shapes and constants
 * - Create delegation (with org chart validation)
 * - Accept / reject / complete / fail / cancel lifecycle
 * - Query functions (pending, sent, chain)
 * - Delegation chain tracing (pure)
 * - E2E flows (delegate down, escalate up)
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import type {
  AgentDelegation,
  DelegationDirection,
  DelegationStatus,
  DelegationChainEntry,
} from "../src/agent-delegations.ts";

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

mock.module("../../ellie-forest/src/index", () => ({
  sql: mockSql,
}));

const {
  createDelegation,
  acceptDelegation,
  rejectDelegation,
  completeDelegation,
  failDelegation,
  cancelDelegation,
  getDelegation,
  getPendingForAgent,
  getSentByAgent,
  getDelegationChain,
  traceDelegationChain,
  VALID_DELEGATION_STATUSES,
} = await import("../src/agent-delegations.ts");

// ── Setup ───────────────────────────────────────────────────

beforeEach(() => {
  resetSqlMock();
});

// ── Helpers ─────────────────────────────────────────────────

function makeDelegation(overrides: Partial<AgentDelegation> = {}): AgentDelegation {
  return {
    id: "del-1",
    created_at: new Date("2026-03-15T10:00:00Z"),
    updated_at: new Date("2026-03-15T10:00:00Z"),
    direction: "delegate",
    from_agent_id: "vp-1",
    to_agent_id: "spec-1",
    status: "pending",
    summary: "Process Q1 billing claims",
    context: {},
    parent_work_session_id: null,
    child_work_session_id: null,
    work_item_id: null,
    accepted_at: null,
    completed_at: null,
    result: null,
    result_context: {},
    ...overrides,
  };
}

// ── Migration SQL ───────────────────────────────────────────

describe("migration SQL", () => {
  function readMigration(): string {
    return readFileSync(
      join(import.meta.dir, "../migrations/supabase/20260315_agent_delegations.sql"),
      "utf-8",
    );
  }

  test("creates agent_delegations table", () => {
    expect(readMigration()).toContain("CREATE TABLE IF NOT EXISTS agent_delegations");
  });

  test("has direction CHECK constraint", () => {
    const sql = readMigration();
    expect(sql).toContain("'delegate'");
    expect(sql).toContain("'escalate'");
  });

  test("has status CHECK constraint with all states", () => {
    const sql = readMigration();
    expect(sql).toContain("'pending'");
    expect(sql).toContain("'accepted'");
    expect(sql).toContain("'completed'");
    expect(sql).toContain("'failed'");
    expect(sql).toContain("'rejected'");
    expect(sql).toContain("'cancelled'");
  });

  test("has FKs to agents for from and to", () => {
    const sql = readMigration();
    expect(sql).toContain("from_agent_id UUID NOT NULL REFERENCES agents(id)");
    expect(sql).toContain("to_agent_id UUID NOT NULL REFERENCES agents(id)");
  });

  test("has FKs to work_sessions", () => {
    const sql = readMigration();
    expect(sql).toContain("parent_work_session_id UUID REFERENCES work_sessions(id)");
    expect(sql).toContain("child_work_session_id UUID REFERENCES work_sessions(id)");
  });

  test("has indexes for from, to, status, pending, and work_item", () => {
    const sql = readMigration();
    expect(sql).toContain("idx_delegations_from");
    expect(sql).toContain("idx_delegations_to");
    expect(sql).toContain("idx_delegations_status");
    expect(sql).toContain("idx_delegations_pending");
    expect(sql).toContain("idx_delegations_work_item");
  });

  test("has RLS enabled", () => {
    expect(readMigration()).toContain("ENABLE ROW LEVEL SECURITY");
  });
});

// ── Constants ───────────────────────────────────────────────

describe("constants", () => {
  test("VALID_DELEGATION_STATUSES has all values", () => {
    expect(VALID_DELEGATION_STATUSES).toContain("pending");
    expect(VALID_DELEGATION_STATUSES).toContain("accepted");
    expect(VALID_DELEGATION_STATUSES).toContain("completed");
    expect(VALID_DELEGATION_STATUSES).toContain("failed");
    expect(VALID_DELEGATION_STATUSES).toContain("rejected");
    expect(VALID_DELEGATION_STATUSES).toContain("cancelled");
    expect(VALID_DELEGATION_STATUSES).toHaveLength(6);
  });
});

// ── Type Shapes ─────────────────────────────────────────────

describe("type shapes", () => {
  test("AgentDelegation has all expected fields", () => {
    const d = makeDelegation();
    expect(d.direction).toBe("delegate");
    expect(d.status).toBe("pending");
    expect(d.child_work_session_id).toBeNull();
  });

  test("DelegationChainEntry has depth", () => {
    const entry: DelegationChainEntry = {
      id: "d1", direction: "delegate", from_agent_id: "a1", to_agent_id: "a2",
      status: "completed", summary: "Do X", created_at: new Date(), depth: 0,
    };
    expect(entry.depth).toBe(0);
  });
});

// ── createDelegation ────────────────────────────────────────

describe("createDelegation", () => {
  test("creates delegation when org chart relationship is valid", async () => {
    // Validation query: spec-1 reports to vp-1
    pushSqlResult([{ reports_to: "vp-1" }]);
    // INSERT
    pushSqlResult([makeDelegation()]);

    const d = await createDelegation({
      direction: "delegate",
      from_agent_id: "vp-1",
      to_agent_id: "spec-1",
      summary: "Process claims",
    });
    expect(d.direction).toBe("delegate");
    expect(d.status).toBe("pending");
  });

  test("creates escalation when org chart relationship is valid", async () => {
    // Validation: spec-1 reports to vp-1
    pushSqlResult([{ reports_to: "vp-1" }]);
    pushSqlResult([makeDelegation({ direction: "escalate", from_agent_id: "spec-1", to_agent_id: "vp-1" })]);

    const d = await createDelegation({
      direction: "escalate",
      from_agent_id: "spec-1",
      to_agent_id: "vp-1",
      summary: "Need help with complex claim",
    });
    expect(d.direction).toBe("escalate");
  });

  test("throws when target does not report to sender (delegation)", async () => {
    pushSqlResult([{ reports_to: "other-agent" }]);

    await expect(
      createDelegation({
        direction: "delegate",
        from_agent_id: "vp-1",
        to_agent_id: "spec-1",
        summary: "Test",
      }),
    ).rejects.toThrow("does not report to sender");
  });

  test("throws when sender does not report to target (escalation)", async () => {
    pushSqlResult([{ reports_to: "other-agent" }]);

    await expect(
      createDelegation({
        direction: "escalate",
        from_agent_id: "spec-1",
        to_agent_id: "vp-1",
        summary: "Test",
      }),
    ).rejects.toThrow("does not report to target");
  });

  test("throws when agent not found", async () => {
    pushSqlResult([]);

    await expect(
      createDelegation({
        direction: "delegate",
        from_agent_id: "vp-1",
        to_agent_id: "nonexistent",
        summary: "Test",
      }),
    ).rejects.toThrow("Agent not found");
  });

  test("passes work_item_id and parent session", async () => {
    pushSqlResult([{ reports_to: "vp-1" }]);
    pushSqlResult([makeDelegation({ work_item_id: "ELLIE-100", parent_work_session_id: "ws-1" })]);

    const d = await createDelegation({
      direction: "delegate",
      from_agent_id: "vp-1",
      to_agent_id: "spec-1",
      summary: "Test",
      work_item_id: "ELLIE-100",
      parent_work_session_id: "ws-1",
    });
    expect(d.work_item_id).toBe("ELLIE-100");
    expect(d.parent_work_session_id).toBe("ws-1");
  });
});

// ── acceptDelegation ────────────────────────────────────────

describe("acceptDelegation", () => {
  test("accepts pending delegation", async () => {
    pushSqlResult([makeDelegation({ status: "accepted", accepted_at: new Date() })]);

    const d = await acceptDelegation("del-1");
    expect(d).not.toBeNull();
    expect(d!.status).toBe("accepted");
  });

  test("links child work session", async () => {
    pushSqlResult([makeDelegation({ status: "accepted", child_work_session_id: "ws-child" })]);

    const d = await acceptDelegation("del-1", "ws-child");
    expect(d!.child_work_session_id).toBe("ws-child");
  });

  test("returns null for non-pending delegation", async () => {
    pushSqlResult([]);
    const d = await acceptDelegation("del-1");
    expect(d).toBeNull();
  });

  test("SQL filters for pending status", async () => {
    pushSqlResult([]);
    await acceptDelegation("del-1");
    expect(sqlCalls[0].strings.join("?")).toContain("status = 'pending'");
  });
});

// ── rejectDelegation ────────────────────────────────────────

describe("rejectDelegation", () => {
  test("rejects with reason", async () => {
    pushSqlResult([makeDelegation({ status: "rejected", result: "Not my area" })]);

    const d = await rejectDelegation("del-1", "Not my area");
    expect(d!.status).toBe("rejected");
    expect(d!.result).toBe("Not my area");
  });

  test("rejects without reason", async () => {
    pushSqlResult([makeDelegation({ status: "rejected", result: null })]);

    const d = await rejectDelegation("del-1");
    expect(d!.result).toBeNull();
  });

  test("returns null for non-pending", async () => {
    pushSqlResult([]);
    expect(await rejectDelegation("del-1")).toBeNull();
  });
});

// ── completeDelegation ──────────────────────────────────────

describe("completeDelegation", () => {
  test("completes accepted delegation with result", async () => {
    pushSqlResult([makeDelegation({
      status: "completed", completed_at: new Date(),
      result: "Processed 200 claims", result_context: { count: 200 },
    })]);

    const d = await completeDelegation("del-1", "Processed 200 claims", { count: 200 });
    expect(d!.status).toBe("completed");
    expect(d!.result).toBe("Processed 200 claims");
  });

  test("returns null for non-accepted delegation", async () => {
    pushSqlResult([]);
    expect(await completeDelegation("del-1")).toBeNull();
  });

  test("SQL filters for accepted status", async () => {
    pushSqlResult([]);
    await completeDelegation("del-1");
    expect(sqlCalls[0].strings.join("?")).toContain("status = 'accepted'");
  });
});

// ── failDelegation ──────────────────────────────────────────

describe("failDelegation", () => {
  test("marks delegation as failed with error", async () => {
    pushSqlResult([makeDelegation({ status: "failed", result: "API timeout" })]);

    const d = await failDelegation("del-1", "API timeout");
    expect(d!.status).toBe("failed");
    expect(d!.result).toBe("API timeout");
  });

  test("returns null for non-accepted", async () => {
    pushSqlResult([]);
    expect(await failDelegation("del-1", "err")).toBeNull();
  });
});

// ── cancelDelegation ────────────────────────────────────────

describe("cancelDelegation", () => {
  test("cancels pending delegation", async () => {
    pushSqlResult([makeDelegation({ status: "cancelled" })]);

    const d = await cancelDelegation("del-1");
    expect(d!.status).toBe("cancelled");
  });

  test("returns null for non-pending", async () => {
    pushSqlResult([]);
    expect(await cancelDelegation("del-1")).toBeNull();
  });
});

// ── getDelegation ───────────────────────────────────────────

describe("getDelegation", () => {
  test("returns delegation when found", async () => {
    pushSqlResult([makeDelegation()]);
    const d = await getDelegation("del-1");
    expect(d).not.toBeNull();
  });

  test("returns null when not found", async () => {
    pushSqlResult([]);
    expect(await getDelegation("nonexistent")).toBeNull();
  });
});

// ── getPendingForAgent ──────────────────────────────────────

describe("getPendingForAgent", () => {
  test("returns pending delegations for agent", async () => {
    pushSqlResult([makeDelegation(), makeDelegation({ id: "del-2" })]);

    const pending = await getPendingForAgent("spec-1");
    expect(pending).toHaveLength(2);
  });

  test("filters by to_agent_id and pending status", async () => {
    pushSqlResult([]);
    await getPendingForAgent("spec-1");

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("to_agent_id =");
    expect(sqlText).toContain("status = 'pending'");
  });
});

// ── getSentByAgent ──────────────────────────────────────────

describe("getSentByAgent", () => {
  test("returns delegations sent by agent", async () => {
    pushSqlResult([makeDelegation()]);
    const sent = await getSentByAgent("vp-1");
    expect(sent).toHaveLength(1);
  });

  test("filters by status when provided", async () => {
    pushSqlResult([]);
    await getSentByAgent("vp-1", { status: "completed" });

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("status =");
  });

  test("uses default limit of 50", async () => {
    pushSqlResult([]);
    await getSentByAgent("vp-1");
    expect(sqlCalls[0].values).toContain(50);
  });
});

// ── getDelegationChain ──────────────────────────────────────

describe("getDelegationChain", () => {
  test("returns delegations for a work item", async () => {
    pushSqlResult([
      makeDelegation({ id: "d1", work_item_id: "ELLIE-100" }),
      makeDelegation({ id: "d2", work_item_id: "ELLIE-100", direction: "escalate" }),
    ]);

    const chain = await getDelegationChain("ELLIE-100");
    expect(chain).toHaveLength(2);
  });

  test("orders by created_at ASC", async () => {
    pushSqlResult([]);
    await getDelegationChain("ELLIE-100");
    expect(sqlCalls[0].strings.join("?")).toContain("ORDER BY created_at ASC");
  });
});

// ── traceDelegationChain (pure) ─────────────────────────────

describe("traceDelegationChain", () => {
  test("builds ordered chain with depth", () => {
    const delegations: AgentDelegation[] = [
      makeDelegation({ id: "d2", created_at: new Date("2026-03-15T11:00:00Z"), direction: "escalate" }),
      makeDelegation({ id: "d1", created_at: new Date("2026-03-15T10:00:00Z") }),
    ];

    const chain = traceDelegationChain(delegations);
    expect(chain).toHaveLength(2);
    expect(chain[0].id).toBe("d1");
    expect(chain[0].depth).toBe(0);
    expect(chain[1].id).toBe("d2");
    expect(chain[1].depth).toBe(1);
  });

  test("handles empty input", () => {
    expect(traceDelegationChain([])).toHaveLength(0);
  });

  test("preserves direction in chain entries", () => {
    const delegations: AgentDelegation[] = [
      makeDelegation({ id: "d1", direction: "delegate", created_at: new Date("2026-03-15T10:00:00Z") }),
      makeDelegation({ id: "d2", direction: "escalate", created_at: new Date("2026-03-15T11:00:00Z") }),
    ];

    const chain = traceDelegationChain(delegations);
    expect(chain[0].direction).toBe("delegate");
    expect(chain[1].direction).toBe("escalate");
  });
});

// ── E2E: Delegation Lifecycle ───────────────────────────────

describe("E2E: delegation lifecycle", () => {
  test("VP delegates to specialist → accept → complete", async () => {
    // Create delegation (org chart validates)
    pushSqlResult([{ reports_to: "vp-1" }]);
    pushSqlResult([makeDelegation()]);
    const d = await createDelegation({
      direction: "delegate",
      from_agent_id: "vp-1",
      to_agent_id: "spec-1",
      summary: "Process Q1 claims",
    });
    expect(d.status).toBe("pending");

    resetSqlMock();

    // Specialist accepts
    pushSqlResult([makeDelegation({ status: "accepted", accepted_at: new Date(), child_work_session_id: "ws-child" })]);
    const accepted = await acceptDelegation(d.id, "ws-child");
    expect(accepted!.status).toBe("accepted");
    expect(accepted!.child_work_session_id).toBe("ws-child");

    resetSqlMock();

    // Specialist completes
    pushSqlResult([makeDelegation({ status: "completed", result: "Done: 200 claims processed" })]);
    const completed = await completeDelegation(d.id, "Done: 200 claims processed");
    expect(completed!.status).toBe("completed");
  });

  test("specialist escalates to VP → VP accepts → VP completes", async () => {
    pushSqlResult([{ reports_to: "vp-1" }]);
    pushSqlResult([makeDelegation({ direction: "escalate", from_agent_id: "spec-1", to_agent_id: "vp-1" })]);
    const d = await createDelegation({
      direction: "escalate",
      from_agent_id: "spec-1",
      to_agent_id: "vp-1",
      summary: "Complex claim needs VP review",
    });
    expect(d.direction).toBe("escalate");

    resetSqlMock();

    pushSqlResult([makeDelegation({ status: "accepted" })]);
    await acceptDelegation(d.id);

    resetSqlMock();

    pushSqlResult([makeDelegation({ status: "completed", result: "Resolved" })]);
    const done = await completeDelegation(d.id, "Resolved");
    expect(done!.status).toBe("completed");
  });

  test("delegation rejected → sender sees rejection", async () => {
    pushSqlResult([{ reports_to: "vp-1" }]);
    pushSqlResult([makeDelegation()]);
    const d = await createDelegation({
      direction: "delegate",
      from_agent_id: "vp-1",
      to_agent_id: "spec-1",
      summary: "Handle this",
    });

    resetSqlMock();

    pushSqlResult([makeDelegation({ status: "rejected", result: "Overloaded" })]);
    const rejected = await rejectDelegation(d.id, "Overloaded");
    expect(rejected!.status).toBe("rejected");
    expect(rejected!.result).toBe("Overloaded");
  });

  test("delegation chain is traceable", () => {
    const delegations: AgentDelegation[] = [
      makeDelegation({ id: "d1", direction: "delegate", from_agent_id: "ceo", to_agent_id: "vp", created_at: new Date("2026-03-15T09:00:00Z"), work_item_id: "ELLIE-100" }),
      makeDelegation({ id: "d2", direction: "delegate", from_agent_id: "vp", to_agent_id: "spec", created_at: new Date("2026-03-15T10:00:00Z"), work_item_id: "ELLIE-100" }),
      makeDelegation({ id: "d3", direction: "escalate", from_agent_id: "spec", to_agent_id: "vp", created_at: new Date("2026-03-15T11:00:00Z"), work_item_id: "ELLIE-100" }),
    ];

    const chain = traceDelegationChain(delegations);
    expect(chain).toHaveLength(3);
    expect(chain[0].direction).toBe("delegate");
    expect(chain[0].from_agent_id).toBe("ceo");
    expect(chain[1].from_agent_id).toBe("vp");
    expect(chain[2].direction).toBe("escalate");
    expect(chain[2].from_agent_id).toBe("spec");
  });
});

// ── SQL Safety ──────────────────────────────────────────────

describe("SQL safety", () => {
  test("createDelegation uses parameterized queries", async () => {
    pushSqlResult([{ reports_to: "vp-1" }]);
    pushSqlResult([makeDelegation()]);

    await createDelegation({
      direction: "delegate",
      from_agent_id: "vp-1",
      to_agent_id: "spec-1",
      summary: "Test",
    });

    // INSERT call (second SQL call)
    const rawSql = sqlCalls[1].strings.join("");
    expect(rawSql).not.toContain("vp-1");
    expect(rawSql).not.toContain("spec-1");
  });
});
