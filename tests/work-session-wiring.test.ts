/**
 * ELLIE-572 — Work Session Lifecycle Wiring Tests
 *
 * Tests that appendHandoffNote and dashboardOnBlocked are called
 * from the session pause handler when a reason is provided.
 *
 * Mocks all heavy dependencies (Forest, Plane, notification) to isolate
 * the wiring logic in work-session.ts.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Tracking vars ───────────────────────────────────────────────────────────

let _handoffCalls: Array<{ workItemId: string; title: string; note: { whatWasAttempted: string } }> = [];
let _blockedCalls: Array<{ workItemId: string; title: string; blocker: string; since: string }> = [];
let _postMortemCalls: Array<{ workItemId: string; failureType: string }> = [];
let _dashboardPauseCalls: string[] = [];
let _workHistoryCalls: Array<{ workItemId: string; outcome: string }> = [];
let _journalCalls: Array<{ workItemId: string; outcome: string }> = [];

// ── Mock all dependencies ───────────────────────────────────────────────────

mock.module("../src/logger.ts", () => ({
  log: {
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
    }),
  },
}));

mock.module("../src/notification-policy.ts", () => ({
  notify: mock(async () => {}),
}));

mock.module("../src/plane.ts", () => ({
  updateWorkItemOnSessionStart: mock(async () => {}),
  updateWorkItemOnSessionComplete: mock(async () => {}),
}));

mock.module("../src/agent-entity-map.ts", () => ({
  resolveEntityName: mock(() => "dev_agent"),
}));

mock.module("../src/work-trail-writer.ts", () => ({
  writeWorkTrailStart: mock(async () => {}),
  appendWorkTrailProgress: mock(async () => {}),
  buildWorkTrailUpdateAppend: mock(() => ""),
  buildWorkTrailCompleteAppend: mock(() => ""),
}));

mock.module("../src/dispatch-verifier.ts", () => ({
  verifyDispatch: mock(async () => {}),
}));

mock.module("../src/dispatch-journal.ts", () => ({
  journalDispatchStart: mock(async () => {}),
  journalDispatchEnd: mock(async (data: { workItemId: string; outcome: string }) => {
    _journalCalls.push({ workItemId: data.workItemId, outcome: data.outcome });
  }),
}));

mock.module("../src/active-tickets-dashboard.ts", () => ({
  dashboardOnStart: mock(async () => {}),
  dashboardOnComplete: mock(async () => {}),
  dashboardOnPause: mock(async (id: string) => {
    _dashboardPauseCalls.push(id);
  }),
  dashboardOnBlocked: mock(async (entry: { workItemId: string; title: string; blocker: string; since: string }) => {
    _blockedCalls.push(entry);
  }),
}));

mock.module("../src/ticket-context-card.ts", () => ({
  ensureContextCard: mock(async () => {}),
  appendWorkHistory: mock(async (id: string, _title: string, entry: { outcome: string }) => {
    _workHistoryCalls.push({ workItemId: id, outcome: entry.outcome });
  }),
  appendHandoffNote: mock(async (id: string, title: string, note: { whatWasAttempted: string }) => {
    _handoffCalls.push({ workItemId: id, title, note });
    return true;
  }),
}));

mock.module("../src/post-mortem.ts", () => ({
  writePostMortem: mock(async (data: { workItemId: string; failureType: string }) => {
    _postMortemCalls.push({ workItemId: data.workItemId, failureType: data.failureType });
    return true;
  }),
  classifyPauseReason: (reason: string) => {
    const lower = reason.toLowerCase();
    if (lower.includes("timed out") || lower.includes("timeout")) return { failureType: "timeout", patternTags: ["timeout"] };
    if (lower.includes("crash")) return { failureType: "crash", patternTags: ["crash"] };
    if (lower.includes("blocked") || lower.includes("missing")) return { failureType: "blocked", patternTags: ["blocked"] };
    return { failureType: "unknown", patternTags: ["unclassified"] };
  },
}));

mock.module("../src/jobs-ledger.ts", () => ({
  findJobByTreeId: mock(async () => null),
  writeJobTouchpointForAgent: mock(async () => {}),
}));

// Mock Forest functions
const mockTree = {
  id: "tree-123",
  title: "Test ticket title",
  state: "growing",
  created_at: new Date().toISOString(),
};

mock.module("../../ellie-forest/src/index", () => ({
  startWorkSession: mock(async () => ({
    tree: mockTree,
    trunk: {},
    creatures: [],
    branches: [],
  })),
  completeWorkSession: mock(async () => {}),
  pauseWorkSession: mock(async () => ({ success: true })),
  resumeWorkSession: mock(async () => ({ success: true })),
  addWorkSessionUpdate: mock(async () => {}),
  addWorkSessionDecision: mock(async () => {}),
  getWorkSessionByPlaneId: mock(async () => mockTree),
  getEntity: mock(async () => null),
  getAgent: mock(async () => ({ name: "dev" })),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { pauseWorkSession } from "../src/api/work-session";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeReq(body: Record<string, unknown>) {
  return { body } as any;
}

function makeRes() {
  let _statusCode = 200;
  let _body: unknown;
  const res: any = {
    status: (code: number) => { _statusCode = code; return res; },
    json: (data: unknown) => { _body = data; return res; },
    getStatusCode: () => _statusCode,
    getBody: () => _body,
  };
  return res;
}

function makeBot() {
  return {} as any;
}

// ── Reset ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  _handoffCalls = [];
  _blockedCalls = [];
  _postMortemCalls = [];
  _dashboardPauseCalls = [];
  _workHistoryCalls = [];
  _journalCalls = [];
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("pauseWorkSession — ELLIE-572 wiring", () => {
  test("calls appendHandoffNote when reason is provided", async () => {
    const res = makeRes();
    await pauseWorkSession(
      makeReq({ work_item_id: "ELLIE-100", reason: "Timed out on large test suite", agent: "dev" }),
      res,
      makeBot(),
    );

    // Wait for fire-and-forget promises to settle
    await new Promise(r => setTimeout(r, 50));

    expect(_handoffCalls).toHaveLength(1);
    expect(_handoffCalls[0].workItemId).toBe("ELLIE-100");
    expect(_handoffCalls[0].note.whatWasAttempted).toBe("Timed out on large test suite");
  });

  test("calls dashboardOnBlocked when reason is provided", async () => {
    const res = makeRes();
    await pauseWorkSession(
      makeReq({ work_item_id: "ELLIE-200", reason: "Missing API credentials", agent: "dev" }),
      res,
      makeBot(),
    );

    await new Promise(r => setTimeout(r, 50));

    expect(_blockedCalls).toHaveLength(1);
    expect(_blockedCalls[0].workItemId).toBe("ELLIE-200");
    expect(_blockedCalls[0].blocker).toBe("Missing API credentials");
    expect(_blockedCalls[0].since).toBeTruthy();
  });

  test("does NOT call appendHandoffNote when no reason", async () => {
    const res = makeRes();
    await pauseWorkSession(
      makeReq({ work_item_id: "ELLIE-300" }),
      res,
      makeBot(),
    );

    await new Promise(r => setTimeout(r, 50));

    expect(_handoffCalls).toHaveLength(0);
  });

  test("does NOT call dashboardOnBlocked when no reason", async () => {
    const res = makeRes();
    await pauseWorkSession(
      makeReq({ work_item_id: "ELLIE-300" }),
      res,
      makeBot(),
    );

    await new Promise(r => setTimeout(r, 50));

    expect(_blockedCalls).toHaveLength(0);
  });

  test("calls writePostMortem with classified failureType (ELLIE-573)", async () => {
    const res = makeRes();
    await pauseWorkSession(
      makeReq({ work_item_id: "ELLIE-400", reason: "Agent crashed", agent: "dev" }),
      res,
      makeBot(),
    );

    await new Promise(r => setTimeout(r, 50));

    expect(_postMortemCalls).toHaveLength(1);
    expect(_postMortemCalls[0].workItemId).toBe("ELLIE-400");
    expect(_postMortemCalls[0].failureType).toBe("crash");
  });

  test("calls dashboardOnPause regardless of reason", async () => {
    const res = makeRes();
    await pauseWorkSession(
      makeReq({ work_item_id: "ELLIE-500" }),
      res,
      makeBot(),
    );

    await new Promise(r => setTimeout(r, 50));

    expect(_dashboardPauseCalls).toContain("ELLIE-500");
  });

  test("calls appendWorkHistory with paused outcome", async () => {
    const res = makeRes();
    await pauseWorkSession(
      makeReq({ work_item_id: "ELLIE-600", reason: "Blocked on review" }),
      res,
      makeBot(),
    );

    await new Promise(r => setTimeout(r, 50));

    expect(_workHistoryCalls.some(c => c.workItemId === "ELLIE-600" && c.outcome === "paused")).toBe(true);
  });

  test("all fire-and-forget calls happen in parallel with reason", async () => {
    const res = makeRes();
    await pauseWorkSession(
      makeReq({ work_item_id: "ELLIE-700", reason: "Timed out" }),
      res,
      makeBot(),
    );

    await new Promise(r => setTimeout(r, 50));

    // All should have been called
    expect(_handoffCalls).toHaveLength(1);
    expect(_blockedCalls).toHaveLength(1);
    expect(_postMortemCalls).toHaveLength(1);
    expect(_dashboardPauseCalls).toHaveLength(1);
    expect(_workHistoryCalls).toHaveLength(1);
    expect(_journalCalls).toHaveLength(1);
  });

  test("classifies timeout reason in post-mortem (ELLIE-573)", async () => {
    const res = makeRes();
    await pauseWorkSession(
      makeReq({ work_item_id: "ELLIE-750", reason: "Timed out on build", agent: "dev" }),
      res,
      makeBot(),
    );

    await new Promise(r => setTimeout(r, 50));

    expect(_postMortemCalls).toHaveLength(1);
    expect(_postMortemCalls[0].failureType).toBe("timeout");
  });

  test("classifies unrecognized reason as unknown (ELLIE-573)", async () => {
    const res = makeRes();
    await pauseWorkSession(
      makeReq({ work_item_id: "ELLIE-760", reason: "Lunch break", agent: "dev" }),
      res,
      makeBot(),
    );

    await new Promise(r => setTimeout(r, 50));

    expect(_postMortemCalls).toHaveLength(1);
    expect(_postMortemCalls[0].failureType).toBe("unknown");
  });

  test("uses tree title in handoff note", async () => {
    const res = makeRes();
    await pauseWorkSession(
      makeReq({ work_item_id: "ELLIE-800", reason: "Blocked" }),
      res,
      makeBot(),
    );

    await new Promise(r => setTimeout(r, 50));

    expect(_handoffCalls[0].title).toBe("Test ticket title");
  });
});
