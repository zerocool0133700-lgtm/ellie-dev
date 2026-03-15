/**
 * Formation Approval Gates Tests — ELLIE-726
 *
 * Tests for human-in-the-loop approval gates:
 * - Migration SQL structure
 * - Type shapes and constants
 * - Request approval
 * - Approve / reject
 * - Timeout handling
 * - Gate check (can_proceed logic)
 * - Query functions
 * - E2E lifecycle
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import type { FormationApproval, ApprovalStatus, ApprovalGateResult } from "../src/formation-approvals.ts";

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
  requestApproval,
  approveRequest,
  rejectRequest,
  expireTimedOutApprovals,
  checkApprovalGate,
  getApproval,
  getSessionApprovals,
  getPendingApprovals,
  setExternalMessageId,
  VALID_APPROVAL_STATUSES,
  DEFAULT_TIMEOUT_SECONDS,
} = await import("../src/formation-approvals.ts");

// ── Setup ───────────────────────────────────────────────────

beforeEach(() => {
  resetSqlMock();
});

// ── Helpers ─────────────────────────────────────────────────

function makeApproval(overrides: Partial<FormationApproval> = {}): FormationApproval {
  return {
    id: "appr-1",
    created_at: new Date(),
    formation_session_id: "sess-1",
    required_approver_id: null,
    status: "pending",
    requested_at: new Date(),
    responded_at: null,
    timeout_seconds: 3600,
    summary: "Boardroom wants to hire a new agent",
    context: {},
    responded_by: null,
    rejection_reason: null,
    channel: "telegram",
    external_message_id: null,
    ...overrides,
  };
}

// ── Migration SQL ───────────────────────────────────────────

describe("migration SQL", () => {
  function readMigration(): string {
    return readFileSync(
      join(import.meta.dir, "../migrations/supabase/20260315_formation_approvals.sql"),
      "utf-8",
    );
  }

  test("creates formation_approvals table", () => {
    expect(readMigration()).toContain("CREATE TABLE IF NOT EXISTS formation_approvals");
  });

  test("has FK to formation_sessions with CASCADE", () => {
    const sql = readMigration();
    expect(sql).toContain("REFERENCES formation_sessions(id) ON DELETE CASCADE");
  });

  test("has required_approver_id FK to agents", () => {
    expect(readMigration()).toContain("REFERENCES agents(id)");
  });

  test("has status CHECK constraint", () => {
    const sql = readMigration();
    expect(sql).toContain("'pending'");
    expect(sql).toContain("'approved'");
    expect(sql).toContain("'rejected'");
    expect(sql).toContain("'timed_out'");
  });

  test("has timeout_seconds column", () => {
    expect(readMigration()).toContain("timeout_seconds INTEGER");
  });

  test("has summary and context columns", () => {
    const sql = readMigration();
    expect(sql).toContain("summary TEXT NOT NULL");
    expect(sql).toContain("context JSONB");
  });

  test("has channel and external_message_id", () => {
    const sql = readMigration();
    expect(sql).toContain("channel TEXT NOT NULL");
    expect(sql).toContain("external_message_id TEXT");
  });

  test("has indexes for session, status, and pending lookups", () => {
    const sql = readMigration();
    expect(sql).toContain("idx_formation_approvals_session");
    expect(sql).toContain("idx_formation_approvals_status");
    expect(sql).toContain("idx_formation_approvals_pending");
  });

  test("has RLS enabled", () => {
    expect(readMigration()).toContain("ENABLE ROW LEVEL SECURITY");
  });
});

// ── Constants ───────────────────────────────────────────────

describe("constants", () => {
  test("VALID_APPROVAL_STATUSES has all values", () => {
    expect(VALID_APPROVAL_STATUSES).toContain("pending");
    expect(VALID_APPROVAL_STATUSES).toContain("approved");
    expect(VALID_APPROVAL_STATUSES).toContain("rejected");
    expect(VALID_APPROVAL_STATUSES).toContain("timed_out");
    expect(VALID_APPROVAL_STATUSES).toHaveLength(4);
  });

  test("DEFAULT_TIMEOUT_SECONDS is 1 hour", () => {
    expect(DEFAULT_TIMEOUT_SECONDS).toBe(3600);
  });
});

// ── Type Shapes ─────────────────────────────────────────────

describe("type shapes", () => {
  test("FormationApproval has all expected fields", () => {
    const a = makeApproval();
    expect(a.status).toBe("pending");
    expect(a.timeout_seconds).toBe(3600);
    expect(a.responded_at).toBeNull();
  });

  test("ApprovalGateResult can_proceed variants", () => {
    const approved: ApprovalGateResult = {
      can_proceed: true, status: "approved", approval_id: "a1", rejection_reason: null,
    };
    const rejected: ApprovalGateResult = {
      can_proceed: false, status: "rejected", approval_id: "a1", rejection_reason: "Too risky",
    };
    expect(approved.can_proceed).toBe(true);
    expect(rejected.can_proceed).toBe(false);
    expect(rejected.rejection_reason).toBe("Too risky");
  });
});

// ── requestApproval ─────────────────────────────────────────

describe("requestApproval", () => {
  test("creates approval and returns it", async () => {
    pushSqlResult([makeApproval()]);

    const approval = await requestApproval({
      formation_session_id: "sess-1",
      summary: "Hire a new agent",
    });
    expect(approval.status).toBe("pending");
    expect(approval.summary).toBe("Boardroom wants to hire a new agent");
  });

  test("defaults to telegram channel", async () => {
    pushSqlResult([makeApproval()]);

    await requestApproval({
      formation_session_id: "sess-1",
      summary: "Test",
    });

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("INSERT INTO formation_approvals");
  });

  test("accepts custom timeout", async () => {
    pushSqlResult([makeApproval({ timeout_seconds: 300 })]);

    const approval = await requestApproval({
      formation_session_id: "sess-1",
      summary: "Urgent",
      timeout_seconds: 300,
    });
    expect(approval.timeout_seconds).toBe(300);
  });

  test("accepts custom channel", async () => {
    pushSqlResult([makeApproval({ channel: "gchat" })]);

    const approval = await requestApproval({
      formation_session_id: "sess-1",
      summary: "Test",
      channel: "gchat",
    });
    expect(approval.channel).toBe("gchat");
  });
});

// ── approveRequest ──────────────────────────────────────────

describe("approveRequest", () => {
  test("approves pending request", async () => {
    pushSqlResult([makeApproval({
      status: "approved",
      responded_at: new Date(),
      responded_by: "dave",
    })]);

    const approval = await approveRequest("appr-1", "dave");
    expect(approval).not.toBeNull();
    expect(approval!.status).toBe("approved");
    expect(approval!.responded_by).toBe("dave");
  });

  test("returns null for non-pending request", async () => {
    pushSqlResult([]);
    const approval = await approveRequest("appr-1", "dave");
    expect(approval).toBeNull();
  });

  test("SQL filters for pending status", async () => {
    pushSqlResult([]);
    await approveRequest("appr-1", "dave");

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("status = 'pending'");
    expect(sqlText).toContain("status = 'approved'");
  });
});

// ── rejectRequest ───────────────────────────────────────────

describe("rejectRequest", () => {
  test("rejects pending request with reason", async () => {
    pushSqlResult([makeApproval({
      status: "rejected",
      responded_at: new Date(),
      responded_by: "dave",
      rejection_reason: "Too expensive",
    })]);

    const approval = await rejectRequest("appr-1", "dave", "Too expensive");
    expect(approval).not.toBeNull();
    expect(approval!.status).toBe("rejected");
    expect(approval!.rejection_reason).toBe("Too expensive");
  });

  test("rejects without reason", async () => {
    pushSqlResult([makeApproval({
      status: "rejected",
      responded_at: new Date(),
      responded_by: "dave",
      rejection_reason: null,
    })]);

    const approval = await rejectRequest("appr-1", "dave");
    expect(approval!.rejection_reason).toBeNull();
  });

  test("returns null for non-pending request", async () => {
    pushSqlResult([]);
    const approval = await rejectRequest("appr-1", "dave");
    expect(approval).toBeNull();
  });
});

// ── expireTimedOutApprovals ─────────────────────────────────

describe("expireTimedOutApprovals", () => {
  test("marks timed-out approvals", async () => {
    pushSqlResult([
      makeApproval({ id: "appr-1", status: "timed_out", responded_at: new Date() }),
      makeApproval({ id: "appr-2", status: "timed_out", responded_at: new Date() }),
    ]);

    const expired = await expireTimedOutApprovals();
    expect(expired).toHaveLength(2);
    expect(expired[0].status).toBe("timed_out");
  });

  test("returns empty when nothing is timed out", async () => {
    pushSqlResult([]);
    const expired = await expireTimedOutApprovals();
    expect(expired).toHaveLength(0);
  });

  test("SQL uses timeout_seconds interval", async () => {
    pushSqlResult([]);
    await expireTimedOutApprovals();

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("status = 'pending'");
    expect(sqlText).toContain("timeout_seconds");
    expect(sqlText).toContain("interval");
  });
});

// ── checkApprovalGate ───────────────────────────────────────

describe("checkApprovalGate", () => {
  test("returns no_approval_required when no approval exists", async () => {
    pushSqlResult([]);

    const result = await checkApprovalGate("sess-1");
    expect(result.can_proceed).toBe(true);
    expect(result.status).toBe("no_approval_required");
    expect(result.approval_id).toBeNull();
  });

  test("returns can_proceed=true when approved", async () => {
    pushSqlResult([makeApproval({ id: "appr-1", status: "approved" })]);

    const result = await checkApprovalGate("sess-1");
    expect(result.can_proceed).toBe(true);
    expect(result.status).toBe("approved");
    expect(result.approval_id).toBe("appr-1");
  });

  test("returns can_proceed=false when pending", async () => {
    pushSqlResult([makeApproval({ status: "pending" })]);

    const result = await checkApprovalGate("sess-1");
    expect(result.can_proceed).toBe(false);
    expect(result.status).toBe("pending");
  });

  test("returns can_proceed=false when rejected", async () => {
    pushSqlResult([makeApproval({
      status: "rejected",
      rejection_reason: "Not safe",
    })]);

    const result = await checkApprovalGate("sess-1");
    expect(result.can_proceed).toBe(false);
    expect(result.status).toBe("rejected");
    expect(result.rejection_reason).toBe("Not safe");
  });

  test("returns can_proceed=false when timed_out", async () => {
    pushSqlResult([makeApproval({ status: "timed_out" })]);

    const result = await checkApprovalGate("sess-1");
    expect(result.can_proceed).toBe(false);
    expect(result.status).toBe("timed_out");
  });

  test("uses most recent approval (ORDER BY requested_at DESC)", async () => {
    pushSqlResult([makeApproval({ status: "approved" })]);

    await checkApprovalGate("sess-1");

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("ORDER BY requested_at DESC");
    expect(sqlText).toContain("LIMIT 1");
  });
});

// ── getApproval ─────────────────────────────────────────────

describe("getApproval", () => {
  test("returns approval when found", async () => {
    pushSqlResult([makeApproval()]);
    const approval = await getApproval("appr-1");
    expect(approval).not.toBeNull();
  });

  test("returns null when not found", async () => {
    pushSqlResult([]);
    const approval = await getApproval("nonexistent");
    expect(approval).toBeNull();
  });
});

// ── getSessionApprovals ─────────────────────────────────────

describe("getSessionApprovals", () => {
  test("returns all approvals for a session", async () => {
    pushSqlResult([
      makeApproval({ id: "a1", status: "rejected" }),
      makeApproval({ id: "a2", status: "approved" }),
    ]);

    const approvals = await getSessionApprovals("sess-1");
    expect(approvals).toHaveLength(2);
  });

  test("orders by requested_at DESC", async () => {
    pushSqlResult([]);
    await getSessionApprovals("sess-1");

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("ORDER BY requested_at DESC");
  });
});

// ── getPendingApprovals ─────────────────────────────────────

describe("getPendingApprovals", () => {
  test("returns pending approvals", async () => {
    pushSqlResult([
      makeApproval({ id: "a1" }),
      makeApproval({ id: "a2" }),
    ]);

    const pending = await getPendingApprovals();
    expect(pending).toHaveLength(2);
  });

  test("filters by channel when provided", async () => {
    pushSqlResult([]);
    await getPendingApprovals({ channel: "gchat" });

    const sqlText = sqlCalls[0].strings.join("?");
    expect(sqlText).toContain("channel =");
  });

  test("uses default limit of 50", async () => {
    pushSqlResult([]);
    await getPendingApprovals();
    expect(sqlCalls[0].values).toContain(50);
  });

  test("accepts custom limit", async () => {
    pushSqlResult([]);
    await getPendingApprovals({ limit: 5 });
    expect(sqlCalls[0].values).toContain(5);
  });
});

// ── setExternalMessageId ────────────────────────────────────

describe("setExternalMessageId", () => {
  test("updates external message ID", async () => {
    pushSqlResult([makeApproval({ external_message_id: "tg-msg-123" })]);

    const approval = await setExternalMessageId("appr-1", "tg-msg-123");
    expect(approval).not.toBeNull();
    expect(approval!.external_message_id).toBe("tg-msg-123");
  });

  test("returns null for nonexistent approval", async () => {
    pushSqlResult([]);
    const approval = await setExternalMessageId("nonexistent", "msg-1");
    expect(approval).toBeNull();
  });
});

// ── E2E: Approval Lifecycle ─────────────────────────────────

describe("E2E: approval lifecycle", () => {
  test("request → pending check → approve → proceed", async () => {
    // Request
    pushSqlResult([makeApproval()]);
    const approval = await requestApproval({
      formation_session_id: "sess-1",
      summary: "Hire agent",
    });
    expect(approval.status).toBe("pending");

    resetSqlMock();

    // Gate check (pending — blocked)
    pushSqlResult([makeApproval({ id: approval.id, status: "pending" })]);
    const gate1 = await checkApprovalGate("sess-1");
    expect(gate1.can_proceed).toBe(false);
    expect(gate1.status).toBe("pending");

    resetSqlMock();

    // Approve
    pushSqlResult([makeApproval({
      id: approval.id,
      status: "approved",
      responded_at: new Date(),
      responded_by: "dave",
    })]);
    const approved = await approveRequest(approval.id, "dave");
    expect(approved!.status).toBe("approved");

    resetSqlMock();

    // Gate check (approved — proceed)
    pushSqlResult([makeApproval({ id: approval.id, status: "approved" })]);
    const gate2 = await checkApprovalGate("sess-1");
    expect(gate2.can_proceed).toBe(true);
    expect(gate2.status).toBe("approved");
  });

  test("request → reject → halt", async () => {
    pushSqlResult([makeApproval()]);
    const approval = await requestApproval({
      formation_session_id: "sess-1",
      summary: "Submit 500 claims",
    });

    resetSqlMock();

    pushSqlResult([makeApproval({
      id: approval.id,
      status: "rejected",
      responded_by: "dave",
      rejection_reason: "Too many claims, review first",
    })]);
    const rejected = await rejectRequest(approval.id, "dave", "Too many claims, review first");
    expect(rejected!.status).toBe("rejected");

    resetSqlMock();

    pushSqlResult([makeApproval({
      id: approval.id,
      status: "rejected",
      rejection_reason: "Too many claims, review first",
    })]);
    const gate = await checkApprovalGate("sess-1");
    expect(gate.can_proceed).toBe(false);
    expect(gate.rejection_reason).toBe("Too many claims, review first");
  });

  test("request → timeout → halt", async () => {
    pushSqlResult([makeApproval({ timeout_seconds: 60 })]);
    await requestApproval({
      formation_session_id: "sess-1",
      summary: "Pivot strategy",
      timeout_seconds: 60,
    });

    resetSqlMock();

    // Expire
    pushSqlResult([makeApproval({ status: "timed_out", responded_at: new Date() })]);
    const expired = await expireTimedOutApprovals();
    expect(expired).toHaveLength(1);

    resetSqlMock();

    // Gate check
    pushSqlResult([makeApproval({ status: "timed_out" })]);
    const gate = await checkApprovalGate("sess-1");
    expect(gate.can_proceed).toBe(false);
    expect(gate.status).toBe("timed_out");
  });

  test("no approval required — formation proceeds freely", async () => {
    pushSqlResult([]);
    const gate = await checkApprovalGate("sess-no-approval");
    expect(gate.can_proceed).toBe(true);
    expect(gate.status).toBe("no_approval_required");
  });
});

// ── SQL Safety ──────────────────────────────────────────────

describe("SQL safety", () => {
  test("requestApproval uses parameterized queries", async () => {
    pushSqlResult([makeApproval()]);

    await requestApproval({
      formation_session_id: "sess-1",
      summary: "Test approval",
    });

    const rawSql = sqlCalls[0].strings.join("");
    expect(rawSql).not.toContain("sess-1");
    expect(rawSql).not.toContain("Test approval");
  });

  test("approveRequest uses parameterized queries", async () => {
    pushSqlResult([]);
    await approveRequest("appr-1", "dave");

    const rawSql = sqlCalls[0].strings.join("");
    expect(rawSql).not.toContain("appr-1");
    expect(rawSql).not.toContain("dave");
  });
});
