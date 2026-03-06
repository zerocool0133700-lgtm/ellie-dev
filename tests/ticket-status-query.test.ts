/**
 * ELLIE-568 — Ticket Status Query Tests
 *
 * Tests the pure reconciliation logic (discrepancy detection, outcome extraction,
 * state mapping, summary building) and the effectful queryRiver/queryTicketStatus
 * with injected dependencies.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";

// ── Mock logger ─────────────────────────────────────────────────────────────

mock.module("../src/logger.ts", () => ({
  log: {
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
    }),
  },
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import {
  stateGroupLabel,
  extractLastVerifiedAt,
  extractRiverOutcome,
  expectedPlaneStateGroup,
  findDiscrepancies,
  buildStatusSummary,
  queryRiver,
  queryTicketStatus,
  type RiverEvidence,
  type RiverDoc,
  type PlaneState,
  type Discrepancy,
} from "../src/ticket-status-query";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeRiverDoc(overrides: Partial<RiverDoc> = {}): RiverDoc {
  return {
    file: "work-trails/ELLIE-100/ELLIE-100-2026-03-05.md",
    title: "ELLIE-100 Work Trail",
    snippet: "status: done",
    score: 5.0,
    ...overrides,
  };
}

function makePlaneState(overrides: Partial<PlaneState> = {}): PlaneState {
  return {
    stateGroup: "started",
    stateName: "In Progress",
    title: "Test ticket",
    priority: "high",
    updatedAt: "2026-03-05T12:00:00Z",
    ...overrides,
  };
}

function makeRiverEvidence(overrides: Partial<RiverEvidence> = {}): RiverEvidence {
  return {
    workTrails: [],
    verificationLogs: [],
    journalEntries: [],
    contextCard: null,
    ...overrides,
  };
}

// ── stateGroupLabel ─────────────────────────────────────────────────────────

describe("stateGroupLabel", () => {
  test("maps known state groups", () => {
    expect(stateGroupLabel("backlog")).toBe("Backlog");
    expect(stateGroupLabel("unstarted")).toBe("Todo");
    expect(stateGroupLabel("started")).toBe("In Progress");
    expect(stateGroupLabel("completed")).toBe("Done");
    expect(stateGroupLabel("cancelled")).toBe("Cancelled");
  });

  test("returns group name for unknown groups", () => {
    expect(stateGroupLabel("custom")).toBe("custom");
  });

  test("returns Unknown for null", () => {
    expect(stateGroupLabel(null)).toBe("Unknown");
  });
});

// ── extractLastVerifiedAt ───────────────────────────────────────────────────

describe("extractLastVerifiedAt", () => {
  test("extracts timestamp from verification log", () => {
    const logs = [
      makeRiverDoc({
        file: "verification/ELLIE-100.md",
        snippet: "Verified at 2026-03-05T12:30:00Z — all checks passed",
      }),
    ];
    expect(extractLastVerifiedAt(logs)).toBe("2026-03-05T12:30:00");
  });

  test("returns latest timestamp when multiple logs", () => {
    const logs = [
      makeRiverDoc({
        file: "verification/ELLIE-100-1.md",
        snippet: "Verified at 2026-03-05T10:00:00Z",
      }),
      makeRiverDoc({
        file: "verification/ELLIE-100-2.md",
        snippet: "Verified at 2026-03-05T14:00:00Z",
      }),
    ];
    expect(extractLastVerifiedAt(logs)).toBe("2026-03-05T14:00:00");
  });

  test("returns null for empty logs", () => {
    expect(extractLastVerifiedAt([])).toBeNull();
  });

  test("returns null when no timestamp found", () => {
    const logs = [makeRiverDoc({ snippet: "No timestamp here" })];
    expect(extractLastVerifiedAt(logs)).toBeNull();
  });
});

// ── extractRiverOutcome ─────────────────────────────────────────────────────

describe("extractRiverOutcome", () => {
  test("extracts outcome from journal entry", () => {
    const river = makeRiverEvidence({
      journalEntries: [
        makeRiverDoc({
          file: "dispatch-journal/2026-03-05.md",
          snippet: "**Outcome:** completed",
        }),
      ],
    });
    expect(extractRiverOutcome(river)).toBe("completed");
  });

  test("extracts outcome from journal H3 header", () => {
    const river = makeRiverEvidence({
      journalEntries: [
        makeRiverDoc({
          file: "dispatch-journal/2026-03-05.md",
          snippet: "### ELLIE-100 — Timeout\n\n**Time:** 2026-03-05T12:00:00Z",
        }),
      ],
    });
    expect(extractRiverOutcome(river)).toBe("timeout");
  });

  test("extracts status from work trail", () => {
    const river = makeRiverEvidence({
      workTrails: [
        makeRiverDoc({
          file: "work-trails/ELLIE-100/ELLIE-100-2026-03-05.md",
          snippet: "status: done",
        }),
      ],
    });
    expect(extractRiverOutcome(river)).toBe("done");
  });

  test("extracts outcome from context card", () => {
    const river = makeRiverEvidence({
      contextCard: "**Outcome:** blocked\n**Summary:** Missing API key",
    });
    expect(extractRiverOutcome(river)).toBe("blocked");
  });

  test("prefers journal over work trail", () => {
    const river = makeRiverEvidence({
      journalEntries: [
        makeRiverDoc({
          snippet: "**Outcome:** completed",
        }),
      ],
      workTrails: [
        makeRiverDoc({
          snippet: "status: in-progress",
        }),
      ],
    });
    expect(extractRiverOutcome(river)).toBe("completed");
  });

  test("returns null when no evidence", () => {
    expect(extractRiverOutcome(makeRiverEvidence())).toBeNull();
  });
});

// ── expectedPlaneStateGroup ─────────────────────────────────────────────────

describe("expectedPlaneStateGroup", () => {
  test("completed maps to completed", () => {
    expect(expectedPlaneStateGroup("completed")).toBe("completed");
    expect(expectedPlaneStateGroup("done")).toBe("completed");
  });

  test("active states map to started", () => {
    expect(expectedPlaneStateGroup("timeout")).toBe("started");
    expect(expectedPlaneStateGroup("crashed")).toBe("started");
    expect(expectedPlaneStateGroup("paused")).toBe("started");
    expect(expectedPlaneStateGroup("blocked")).toBe("started");
    expect(expectedPlaneStateGroup("in-progress")).toBe("started");
  });

  test("unknown outcome returns null", () => {
    expect(expectedPlaneStateGroup("unknown")).toBeNull();
  });
});

// ── findDiscrepancies ───────────────────────────────────────────────────────

describe("findDiscrepancies", () => {
  test("no discrepancies when consistent", () => {
    const river = makeRiverEvidence({
      journalEntries: [
        makeRiverDoc({ snippet: "**Outcome:** completed" }),
      ],
    });
    const plane = makePlaneState({ stateGroup: "completed" });

    const discrepancies = findDiscrepancies(river, plane);
    expect(discrepancies).toHaveLength(0);
  });

  test("detects state mismatch: River completed, Plane started", () => {
    const river = makeRiverEvidence({
      journalEntries: [
        makeRiverDoc({ snippet: "**Outcome:** completed" }),
      ],
    });
    const plane = makePlaneState({ stateGroup: "started" });

    const discrepancies = findDiscrepancies(river, plane);
    expect(discrepancies).toHaveLength(1);
    expect(discrepancies[0].field).toBe("state");
    expect(discrepancies[0].severity).toBe("critical");
    expect(discrepancies[0].riverSays).toContain("completed");
    expect(discrepancies[0].planeSays).toContain("In Progress");
  });

  test("detects stale state: River timeout, Plane started", () => {
    const river = makeRiverEvidence({
      journalEntries: [
        makeRiverDoc({
          file: "dispatch-journal/2026-03-05.md",
          snippet: "### ELLIE-100 — Timeout\n\n**Outcome:** timeout",
        }),
      ],
    });
    const plane = makePlaneState({ stateGroup: "started" });

    const discrepancies = findDiscrepancies(river, plane);
    // Should have a stale_state discrepancy
    const stale = discrepancies.find((d) => d.field === "stale_state");
    expect(stale).toBeDefined();
    expect(stale!.severity).toBe("critical");
    expect(stale!.riverSays).toContain("timeout");
  });

  test("no discrepancies when no River outcome", () => {
    const river = makeRiverEvidence();
    const plane = makePlaneState({ stateGroup: "started" });

    expect(findDiscrepancies(river, plane)).toHaveLength(0);
  });

  test("no discrepancies when no Plane state", () => {
    const river = makeRiverEvidence({
      journalEntries: [
        makeRiverDoc({ snippet: "**Outcome:** completed" }),
      ],
    });
    const plane = makePlaneState({ stateGroup: null });

    expect(findDiscrepancies(river, plane)).toHaveLength(0);
  });
});

// ── buildStatusSummary ──────────────────────────────────────────────────────

describe("buildStatusSummary", () => {
  test("builds summary with no discrepancies", () => {
    const river = makeRiverEvidence({
      workTrails: [makeRiverDoc()],
      contextCard: "card content",
    });
    const plane = makePlaneState({ stateGroup: "completed" });

    const summary = buildStatusSummary("ELLIE-100", river, plane, [], null);

    expect(summary).toContain("## Status: ELLIE-100");
    expect(summary).toContain("**Plane State:** Done");
    expect(summary).toContain("**River Evidence:** 2 document(s) found");
    expect(summary).toContain("1 work trail(s)");
    expect(summary).toContain("Context card found");
    expect(summary).toContain("No discrepancies detected");
  });

  test("builds summary with discrepancies", () => {
    const river = makeRiverEvidence();
    const plane = makePlaneState({ stateGroup: "started" });
    const discrepancies: Discrepancy[] = [
      {
        field: "state",
        riverSays: "completed",
        planeSays: "In Progress",
        severity: "critical",
      },
    ];

    const summary = buildStatusSummary("ELLIE-100", river, plane, discrepancies, "2026-03-05T12:00:00");

    expect(summary).toContain("### Discrepancies");
    expect(summary).toContain("🔴");
    expect(summary).toContain("**Last Verified:** 2026-03-05T12:00:00");
  });

  test("includes title and priority from Plane", () => {
    const river = makeRiverEvidence();
    const plane = makePlaneState({
      title: "Fix the bug",
      priority: "urgent",
    });

    const summary = buildStatusSummary("ELLIE-200", river, plane, [], null);

    expect(summary).toContain("**Title:** Fix the bug");
    expect(summary).toContain("**Priority:** urgent");
  });

  test("shows warning icon for warning severity", () => {
    const discrepancies: Discrepancy[] = [
      {
        field: "stale_state",
        riverSays: "timeout",
        planeSays: "In Progress",
        severity: "warning",
      },
    ];

    const summary = buildStatusSummary("ELLIE-100", makeRiverEvidence(), makePlaneState(), discrepancies, null);
    expect(summary).toContain("🟡");
  });
});

// ── queryRiver (effectful with injected deps) ───────────────────────────────

describe("queryRiver", () => {
  test("categorizes search results by file path", async () => {
    const mockSearch = mock(async () => [
      { file: "work-trails/ELLIE-100/ELLIE-100-2026-03-05.md", title: "WT", snippet: "s1", score: 5 },
      { file: "dispatch-journal/2026-03-05.md", title: "DJ", snippet: "s2", score: 4 },
      { file: "verification/ELLIE-100.md", title: "VL", snippet: "s3", score: 3 },
      { file: "tickets/ELLIE-100.md", title: "CC", snippet: "s4", score: 2 },
    ]);
    const mockReadCard = mock(async () => "context card content");

    const evidence = await queryRiver("ELLIE-100", mockSearch, mockReadCard);

    expect(evidence.workTrails).toHaveLength(1);
    expect(evidence.workTrails[0].file).toContain("work-trails/");
    expect(evidence.journalEntries).toHaveLength(1);
    expect(evidence.journalEntries[0].file).toContain("dispatch-journal/");
    expect(evidence.verificationLogs).toHaveLength(1);
    expect(evidence.verificationLogs[0].file).toContain("verification/");
    expect(evidence.contextCard).toBe("context card content");
  });

  test("handles empty search results", async () => {
    const mockSearch = mock(async () => []);
    const mockReadCard = mock(async () => null);

    const evidence = await queryRiver("ELLIE-999", mockSearch, mockReadCard);

    expect(evidence.workTrails).toHaveLength(0);
    expect(evidence.journalEntries).toHaveLength(0);
    expect(evidence.verificationLogs).toHaveLength(0);
    expect(evidence.contextCard).toBeNull();
  });

  test("passes work item ID to search and readCard", async () => {
    const mockSearch = mock(async () => []);
    const mockReadCard = mock(async () => null);

    await queryRiver("ELLIE-567", mockSearch, mockReadCard);

    expect(mockSearch).toHaveBeenCalledWith("ELLIE-567", 20);
    expect(mockReadCard).toHaveBeenCalledWith("ELLIE-567");
  });
});

// ── queryTicketStatus (full integration with injected deps) ─────────────────

describe("queryTicketStatus", () => {
  test("returns full status report with no discrepancies", async () => {
    const report = await queryTicketStatus("ELLIE-100", {
      searchFn: async () => [
        { file: "work-trails/ELLIE-100/trail.md", title: "WT", snippet: "status: done", score: 5 },
      ],
      readCardFn: async () => null,
      planeFetchFn: async () => makePlaneState({ stateGroup: "completed" }),
    });

    expect(report.workItemId).toBe("ELLIE-100");
    expect(report.river.workTrails).toHaveLength(1);
    expect(report.plane.stateGroup).toBe("completed");
    expect(report.discrepancies).toHaveLength(0);
    expect(report.summary).toContain("No discrepancies detected");
  });

  test("detects discrepancy when River and Plane disagree", async () => {
    const report = await queryTicketStatus("ELLIE-200", {
      searchFn: async () => [
        {
          file: "dispatch-journal/2026-03-05.md",
          title: "DJ",
          snippet: "**Outcome:** completed",
          score: 5,
        },
      ],
      readCardFn: async () => null,
      planeFetchFn: async () => makePlaneState({ stateGroup: "started" }),
    });

    expect(report.discrepancies.length).toBeGreaterThan(0);
    expect(report.discrepancies[0].severity).toBe("critical");
    expect(report.summary).toContain("Discrepancies");
  });

  test("includes last verified timestamp", async () => {
    const report = await queryTicketStatus("ELLIE-300", {
      searchFn: async () => [
        {
          file: "verification/ELLIE-300.md",
          title: "Verification",
          snippet: "Verified at 2026-03-05T14:30:00Z",
          score: 5,
        },
      ],
      readCardFn: async () => null,
      planeFetchFn: async () => makePlaneState({ stateGroup: "completed" }),
    });

    expect(report.lastVerifiedAt).toBe("2026-03-05T14:30:00");
  });

  test("handles errors gracefully", async () => {
    const report = await queryTicketStatus("ELLIE-ERR", {
      searchFn: async () => { throw new Error("QMD down"); },
      readCardFn: async () => null,
      planeFetchFn: async () => { throw new Error("Plane down"); },
    });

    expect(report.workItemId).toBe("ELLIE-ERR");
    expect(report.summary).toContain("Unable to query status");
  });
});
